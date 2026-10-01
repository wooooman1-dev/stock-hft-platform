import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { inflateRawSync } from "node:zlib";

const CACHE_SCHEMA_VERSION = 1;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_QUERY_LENGTH = 40;

export const KIS_INSTRUMENT_MASTER_SOURCES = Object.freeze([
  Object.freeze({
    market: "KOSPI",
    url: "https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip",
    tailLength: 228,
  }),
  Object.freeze({
    market: "KOSDAQ",
    url: "https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip",
    tailLength: 222,
  }),
]);

const SECURITY_TYPE_LABELS = Object.freeze({
  ST: "주식",
  MF: "증권투자회사",
  RT: "리츠",
  SC: "선박투자회사",
  IF: "인프라펀드",
  DR: "주식예탁증서",
  EW: "ELW",
  EF: "ETF",
  SW: "신주인수권증권",
  SR: "신주인수권증서",
  BC: "수익증권",
  FE: "해외ETF",
  FS: "외국주권",
});

export class InstrumentCatalogError extends Error {
  constructor(message, code = "INSTRUMENT_CATALOG_ERROR", statusCode = 500, cause = undefined) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "InstrumentCatalogError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class InstrumentCatalog {
  constructor(cachePath, {
    fetchImpl = globalThis.fetch,
    now = Date.now,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sources = KIS_INSTRUMENT_MASTER_SOURCES,
  } = {}) {
    if (!cachePath) throw new TypeError("종목 카탈로그 캐시 경로가 필요합니다.");
    if (typeof fetchImpl !== "function") throw new TypeError("fetch 구현이 필요합니다.");
    if (typeof now !== "function") throw new TypeError("now는 함수여야 합니다.");
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new TypeError("maxAgeMs는 양수여야 합니다.");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs는 양수여야 합니다.");
    if (!Array.isArray(sources) || sources.length === 0) throw new TypeError("종목 마스터 소스가 필요합니다.");

    this.cachePath = cachePath;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.maxAgeMs = maxAgeMs;
    this.timeoutMs = timeoutMs;
    this.sources = sources.map((source) => ({ ...source }));
    this.instruments = null;
    this.updatedAt = null;
    this.stale = false;
    this.loading = null;
  }

  status() {
    return {
      state: this.instruments ? (this.stale ? "STALE" : "READY") : "NOT_LOADED",
      instrumentCount: this.instruments?.length ?? 0,
      updatedAt: this.updatedAt,
      stale: this.stale,
      markets: this.instruments
        ? countByMarket(this.instruments)
        : {},
    };
  }

  async search(query, { limit = DEFAULT_LIMIT } = {}) {
    const normalizedQuery = normalizeSearchQuery(query);
    const normalizedLimit = normalizeLimit(limit);
    await this.ensureLoaded();
    const ranked = rankInstruments(this.instruments, normalizedQuery)
      .slice(0, normalizedLimit)
      .map(({ score: _score, normalizedName: _normalizedName, ...instrument }) => instrument);
    return {
      query: String(query).trim(),
      total: ranked.length,
      results: ranked,
      catalog: this.status(),
    };
  }

  async findBySymbol(symbol) {
    const normalized = normalizeSymbol(symbol);
    await this.ensureLoaded();
    const found = this.instruments.find((instrument) => instrument.symbol === normalized);
    if (!found) {
      throw new InstrumentCatalogError(
        "종목코드에 해당하는 국내 종목을 찾을 수 없습니다.",
        "INSTRUMENT_NOT_FOUND",
        404,
      );
    }
    return structuredClone(found);
  }

  async ensureLoaded() {
    if (this.instruments) return;
    if (this.loading) return this.loading;
    this.loading = this.loadOrRefresh().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  async loadOrRefresh() {
    const cached = this.readCache();
    const now = this.now();
    if (cached && now - cached.updatedAt <= this.maxAgeMs) {
      this.applyCache(cached, false);
      return;
    }

    try {
      const refreshed = await this.refresh();
      this.applyCache(refreshed, false);
    } catch (error) {
      if (cached) {
        this.applyCache(cached, true);
        return;
      }
      if (error instanceof InstrumentCatalogError) throw error;
      throw new InstrumentCatalogError(
        `종목 마스터를 준비하지 못했습니다: ${formatError(error)}`,
        "INSTRUMENT_CATALOG_UNAVAILABLE",
        503,
        error,
      );
    }
  }

  applyCache(cache, stale) {
    this.instruments = cache.instruments.map((instrument) => ({ ...instrument }));
    this.updatedAt = cache.updatedAt;
    this.stale = stale;
  }

  readCache() {
    if (!existsSync(this.cachePath)) return null;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.cachePath, "utf8"));
    } catch (error) {
      throw new InstrumentCatalogError(
        `종목 카탈로그 캐시를 읽을 수 없습니다: ${formatError(error)}`,
        "INSTRUMENT_CATALOG_CACHE_INVALID",
        500,
        error,
      );
    }
    validateCache(parsed);
    return parsed;
  }

  async refresh() {
    const downloaded = await Promise.all(this.sources.map((source) => this.downloadSource(source)));
    const bySymbol = new Map();
    for (const list of downloaded) {
      for (const instrument of list) {
        const existing = bySymbol.get(instrument.symbol);
        if (!existing || marketPriority(instrument.market) < marketPriority(existing.market)) {
          bySymbol.set(instrument.symbol, instrument);
        }
      }
    }
    const instruments = [...bySymbol.values()].sort((left, right) => (
      left.symbol.localeCompare(right.symbol, "ko-KR")
    ));
    if (instruments.length < 100) {
      throw new InstrumentCatalogError(
        `종목 마스터 결과가 비정상적으로 적습니다: ${instruments.length}개`,
        "INSTRUMENT_CATALOG_TOO_SMALL",
        503,
      );
    }
    const cache = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      updatedAt: this.now(),
      instruments,
    };
    this.writeCache(cache);
    return cache;
  }

  async downloadSource(source) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(source.url, {
        method: "GET",
        headers: { Accept: "application/zip, application/octet-stream" },
        signal: controller.signal,
      });
    } catch (error) {
      const timeoutFailure = error?.name === "AbortError";
      throw new InstrumentCatalogError(
        timeoutFailure
          ? `${source.market} 종목 마스터 다운로드 시간이 초과되었습니다.`
          : `${source.market} 종목 마스터 다운로드에 실패했습니다: ${formatError(error)}`,
        timeoutFailure ? "INSTRUMENT_MASTER_TIMEOUT" : "INSTRUMENT_MASTER_NETWORK_ERROR",
        503,
        error,
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!response?.ok) {
      throw new InstrumentCatalogError(
        `${source.market} 종목 마스터 다운로드가 HTTP ${response?.status ?? "UNKNOWN"}로 실패했습니다.`,
        "INSTRUMENT_MASTER_HTTP_ERROR",
        503,
      );
    }
    let archive;
    try {
      archive = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw new InstrumentCatalogError(
        `${source.market} 종목 마스터 응답을 읽을 수 없습니다.`,
        "INSTRUMENT_MASTER_READ_ERROR",
        503,
        error,
      );
    }
    const masterBytes = extractFirstZipEntry(archive);
    const text = decodeKoreanMaster(masterBytes);
    return parseKisMasterText(text, source);
  }

  writeCache(cache) {
    const directory = dirname(this.cachePath);
    const temporary = `${this.cachePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(temporary, `${JSON.stringify(cache)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.cachePath);
    } catch (error) {
      throw new InstrumentCatalogError(
        `종목 카탈로그 캐시를 저장할 수 없습니다: ${formatError(error)}`,
        "INSTRUMENT_CATALOG_CACHE_WRITE_FAILED",
        500,
        error,
      );
    }
  }
}

export function extractFirstZipEntry(input) {
  const archive = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const eocdOffset = findSignatureBackward(archive, 0x06054b50);
  if (eocdOffset < 0 || eocdOffset + 22 > archive.length) {
    throw new InstrumentCatalogError(
      "종목 마스터 ZIP의 중앙 디렉터리를 찾을 수 없습니다.",
      "INSTRUMENT_MASTER_ZIP_INVALID",
      503,
    );
  }
  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = archive.readUInt32LE(eocdOffset + 16);
  if (entryCount < 1 || centralDirectoryOffset + 46 > archive.length) {
    throw new InstrumentCatalogError(
      "종목 마스터 ZIP에 파일이 없습니다.",
      "INSTRUMENT_MASTER_ZIP_EMPTY",
      503,
    );
  }
  if (archive.readUInt32LE(centralDirectoryOffset) !== 0x02014b50) {
    throw new InstrumentCatalogError(
      "종목 마스터 ZIP 중앙 디렉터리가 손상되었습니다.",
      "INSTRUMENT_MASTER_ZIP_INVALID",
      503,
    );
  }

  const flags = archive.readUInt16LE(centralDirectoryOffset + 8);
  const compressionMethod = archive.readUInt16LE(centralDirectoryOffset + 10);
  const compressedSize = archive.readUInt32LE(centralDirectoryOffset + 20);
  const uncompressedSize = archive.readUInt32LE(centralDirectoryOffset + 24);
  const localHeaderOffset = archive.readUInt32LE(centralDirectoryOffset + 42);
  if ((flags & 0x1) !== 0) {
    throw new InstrumentCatalogError(
      "암호화된 종목 마스터 ZIP은 지원하지 않습니다.",
      "INSTRUMENT_MASTER_ZIP_ENCRYPTED",
      503,
    );
  }
  if (localHeaderOffset + 30 > archive.length || archive.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
    throw new InstrumentCatalogError(
      "종목 마스터 ZIP의 로컬 헤더가 손상되었습니다.",
      "INSTRUMENT_MASTER_ZIP_INVALID",
      503,
    );
  }
  const fileNameLength = archive.readUInt16LE(localHeaderOffset + 26);
  const extraLength = archive.readUInt16LE(localHeaderOffset + 28);
  const dataOffset = localHeaderOffset + 30 + fileNameLength + extraLength;
  const dataEnd = dataOffset + compressedSize;
  if (dataOffset < 0 || dataEnd > archive.length) {
    throw new InstrumentCatalogError(
      "종목 마스터 ZIP 데이터 범위가 손상되었습니다.",
      "INSTRUMENT_MASTER_ZIP_INVALID",
      503,
    );
  }
  const compressed = archive.subarray(dataOffset, dataEnd);
  let output;
  if (compressionMethod === 0) output = Buffer.from(compressed);
  else if (compressionMethod === 8) output = inflateRawSync(compressed);
  else {
    throw new InstrumentCatalogError(
      `지원하지 않는 ZIP 압축 방식입니다: ${compressionMethod}`,
      "INSTRUMENT_MASTER_ZIP_UNSUPPORTED",
      503,
    );
  }
  if (uncompressedSize !== 0 && output.length !== uncompressedSize) {
    throw new InstrumentCatalogError(
      "종목 마스터 ZIP 압축 해제 크기가 일치하지 않습니다.",
      "INSTRUMENT_MASTER_ZIP_INVALID",
      503,
    );
  }
  return output;
}

export function parseKisMasterText(text, { market, tailLength }) {
  if (typeof text !== "string") throw new TypeError("종목 마스터 text는 문자열이어야 합니다.");
  if (typeof market !== "string" || market.length === 0) throw new TypeError("market이 필요합니다.");
  if (!Number.isInteger(tailLength) || tailLength <= 1) throw new TypeError("tailLength가 필요합니다.");

  // KIS 공식 파서는 줄바꿈을 포함해 KOSPI 228자, KOSDAQ 222자를
  // 후반 고정영역으로 취급합니다. split 후에는 줄바꿈 1자를 제외합니다.
  const dataTailLength = tailLength - 1;
  const instruments = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\u0000+$/g, "");
    if (line.length <= 21 + dataTailLength) continue;
    const headEnd = line.length - dataTailLength;
    const head = line.slice(0, headEnd);
    const symbol = head.slice(0, 9).trim().toUpperCase();
    const standardCode = head.slice(9, 21).trim().toUpperCase();
    const name = head.slice(21).trim();
    const securityTypeCode = line.slice(headEnd, headEnd + 2).trim().toUpperCase();
    if (!/^(?:\d{6}|Q\d{6})$/.test(symbol) || !name) continue;
    instruments.push({
      symbol,
      standardCode: standardCode || null,
      name,
      market,
      securityTypeCode: securityTypeCode || null,
      securityType: SECURITY_TYPE_LABELS[securityTypeCode] ?? "기타",
    });
  }
  return instruments;
}

export function rankInstruments(instruments, query) {
  const normalizedQuery = normalizeCompactText(query);
  return instruments
    .map((instrument) => {
      const symbol = instrument.symbol.toUpperCase();
      const standardCode = String(instrument.standardCode ?? "").toUpperCase();
      const normalizedName = normalizeCompactText(instrument.name);
      let score = Number.POSITIVE_INFINITY;
      if (symbol === normalizedQuery) score = 0;
      else if (standardCode === normalizedQuery) score = 1;
      else if (symbol.startsWith(normalizedQuery)) score = 2;
      else if (normalizedName === normalizedQuery) score = 3;
      else if (normalizedName.startsWith(normalizedQuery)) score = 4;
      else if (normalizedName.includes(normalizedQuery)) score = 5;
      else if (standardCode.includes(normalizedQuery)) score = 6;
      return { ...instrument, normalizedName, score };
    })
    .filter((instrument) => Number.isFinite(instrument.score))
    .sort((left, right) => (
      left.score - right.score
      || left.name.length - right.name.length
      || marketPriority(left.market) - marketPriority(right.market)
      || left.symbol.localeCompare(right.symbol, "ko-KR")
    ));
}

function decodeKoreanMaster(buffer) {
  try {
    return new TextDecoder("euc-kr", { fatal: false }).decode(buffer);
  } catch (error) {
    throw new InstrumentCatalogError(
      "종목 마스터의 한글 인코딩을 해석할 수 없습니다.",
      "INSTRUMENT_MASTER_ENCODING_ERROR",
      503,
      error,
    );
  }
}

function validateCache(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidCache("루트 객체가 아닙니다.");
  }
  if (value.schemaVersion !== CACHE_SCHEMA_VERSION) {
    throw invalidCache(`지원하지 않는 schemaVersion ${String(value.schemaVersion)}입니다.`);
  }
  if (!Number.isFinite(value.updatedAt) || value.updatedAt <= 0) {
    throw invalidCache("updatedAt이 올바르지 않습니다.");
  }
  if (!Array.isArray(value.instruments) || value.instruments.length === 0) {
    throw invalidCache("instruments 배열이 비어 있습니다.");
  }
  for (const instrument of value.instruments) {
    if (!instrument || typeof instrument !== "object" || Array.isArray(instrument)) {
      throw invalidCache("종목 항목이 객체가 아닙니다.");
    }
    if (!/^(?:\d{6}|Q\d{6})$/.test(String(instrument.symbol ?? ""))) {
      throw invalidCache("종목코드가 올바르지 않습니다.");
    }
    if (typeof instrument.name !== "string" || instrument.name.trim().length === 0) {
      throw invalidCache("종목명이 올바르지 않습니다.");
    }
    if (!new Set(["KOSPI", "KOSDAQ"]).has(instrument.market)) {
      throw invalidCache("시장 구분이 올바르지 않습니다.");
    }
  }
}

function invalidCache(detail) {
  return new InstrumentCatalogError(
    `종목 카탈로그 캐시 형식이 올바르지 않습니다: ${detail}`,
    "INSTRUMENT_CATALOG_CACHE_INVALID",
    500,
  );
}

function normalizeSearchQuery(value) {
  const query = String(value ?? "").trim();
  if (query.length === 0) {
    throw new InstrumentCatalogError(
      "검색어를 입력하세요.",
      "INSTRUMENT_SEARCH_QUERY_REQUIRED",
      400,
    );
  }
  if (query.length > MAX_QUERY_LENGTH) {
    throw new InstrumentCatalogError(
      `검색어는 ${MAX_QUERY_LENGTH}자 이하여야 합니다.`,
      "INSTRUMENT_SEARCH_QUERY_TOO_LONG",
      400,
    );
  }
  return normalizeCompactText(query);
}

function normalizeLimit(value) {
  const limit = Number(value ?? DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new InstrumentCatalogError(
      `limit은 1 이상 ${MAX_LIMIT} 이하의 정수여야 합니다.`,
      "INSTRUMENT_SEARCH_LIMIT_INVALID",
      400,
    );
  }
  return limit;
}

function normalizeSymbol(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  if (!/^(?:\d{6}|Q\d{6})$/.test(symbol)) {
    throw new InstrumentCatalogError(
      "종목코드는 6자리 숫자 또는 Q로 시작하는 7자리 ETN 코드여야 합니다.",
      "INSTRUMENT_SYMBOL_INVALID",
      400,
    );
  }
  return symbol;
}

function normalizeCompactText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/[\s._()\-·/\\]+/g, "");
}

function countByMarket(instruments) {
  const counts = {};
  for (const instrument of instruments) {
    counts[instrument.market] = (counts[instrument.market] ?? 0) + 1;
  }
  return counts;
}

function marketPriority(market) {
  if (market === "KOSPI") return 0;
  if (market === "KOSDAQ") return 1;
  return 9;
}

function findSignatureBackward(buffer, signature) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
