import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const SCHEMA_VERSION = 1;
const VALID_PRICE_SOURCES = new Set(["ENV_DEFAULT", "KIS_PROD_READ_ONLY"]);

export class SelectedInstrumentError extends Error {
  constructor(message, code = "SELECTED_INSTRUMENT_ERROR", statusCode = 500) {
    super(message);
    this.name = "SelectedInstrumentError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class SelectedInstrumentStore {
  constructor(filePath, { now = Date.now } = {}) {
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new TypeError("selected instrument filePath가 필요합니다.");
    }
    if (typeof now !== "function") throw new TypeError("now는 함수여야 합니다.");
    this.filePath = filePath;
    this.now = now;
  }

  load() {
    if (!existsSync(this.filePath)) return null;
    let payload;
    try {
      payload = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new SelectedInstrumentError(
        `저장된 선택 종목 파일을 읽을 수 없습니다: ${formatError(error)}`,
        "SELECTED_INSTRUMENT_CORRUPT",
      );
    }
    if (payload?.schemaVersion !== SCHEMA_VERSION) {
      throw new SelectedInstrumentError(
        "저장된 선택 종목 스키마 버전이 올바르지 않습니다.",
        "SELECTED_INSTRUMENT_SCHEMA_INVALID",
      );
    }
    return normalizeSelectedInstrument(payload, { requireSelectedAt: true });
  }

  save(input) {
    const selectedAt = Number.isFinite(Number(input?.selectedAt))
      ? Number(input.selectedAt)
      : this.now();
    const normalized = normalizeSelectedInstrument({ ...input, selectedAt });
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      ...normalized,
    };
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${this.now()}.tmp`;
    try {
      writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      try {
        renameSync(tempPath, this.filePath);
      } catch (renameError) {
        if (!existsSync(this.filePath)) throw renameError;
        rmSync(this.filePath, { force: true });
        renameSync(tempPath, this.filePath);
      }
      try { chmodSync(this.filePath, 0o600); } catch { /* Windows permissions differ. */ }
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw new SelectedInstrumentError(
        `선택 종목을 저장할 수 없습니다: ${formatError(error)}`,
        "SELECTED_INSTRUMENT_WRITE_FAILED",
      );
    }
    return structuredClone(normalized);
  }
}

export function normalizeSelectedInstrument(input, { requireSelectedAt = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalid("선택 종목 정보는 객체여야 합니다.");
  }
  const symbol = String(input.symbol ?? "").trim().toUpperCase();
  if (!/^(?:\d{6}|Q\d{6})$/.test(symbol)) {
    throw invalid("선택 종목 symbol은 6자리 종목코드 또는 Q로 시작하는 ETN 코드여야 합니다.");
  }
  const symbolName = String(input.symbolName ?? "").trim();
  if (!symbolName || symbolName.length > 120) {
    throw invalid("선택 종목 symbolName은 1~120자여야 합니다.");
  }
  const market = optionalText(input.market, 20, "market");
  const securityType = optionalText(input.securityType, 40, "securityType");
  const initialPrice = positiveNumber(input.initialPrice, "initialPrice");
  const previousClose = positiveNumber(input.previousClose, "previousClose");
  const tickSize = positiveNumber(input.tickSize, "tickSize");
  const priceSource = String(input.priceSource ?? "").trim().toUpperCase();
  if (!VALID_PRICE_SOURCES.has(priceSource)) {
    throw invalid("선택 종목 priceSource가 올바르지 않습니다.");
  }
  const quoteFetchedAt = nullableTimestamp(input.quoteFetchedAt, "quoteFetchedAt");
  const selectedAt = nullableTimestamp(input.selectedAt, "selectedAt");
  if (requireSelectedAt && selectedAt === null) {
    throw invalid("저장된 선택 종목 selectedAt이 필요합니다.");
  }
  return {
    symbol,
    symbolName,
    market,
    securityType,
    initialPrice,
    previousClose,
    tickSize,
    priceSource,
    quoteFetchedAt,
    selectedAt,
  };
}

function positiveNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw invalid(`${field}는 양수여야 합니다.`);
  }
  return number;
}

function nullableTimestamp(value, field) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw invalid(`${field}는 0 이상의 시각이어야 합니다.`);
  }
  return number;
}

function optionalText(value, maxLength, field) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  if (!text || text.length > maxLength) {
    throw invalid(`${field} 형식이 올바르지 않습니다.`);
  }
  return text;
}

function invalid(message) {
  return new SelectedInstrumentError(message, "SELECTED_INSTRUMENT_INVALID", 400);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
