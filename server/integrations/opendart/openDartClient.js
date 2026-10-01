const DEFAULT_BASE_URL = "https://opendart.fss.or.kr";
const HIGH_RISK_PATTERNS = Object.freeze([
  "유상증자",
  "전환사채",
  "신주인수권부사채",
  "교환사채",
  "감자",
  "상장폐지",
  "거래정지",
  "횡령",
  "배임",
  "감사의견",
  "회생절차",
  "파산",
  "부도",
  "영업정지",
  "관리종목",
]);

export class OpenDartError extends Error {
  constructor(message, code = "OPENDART_ERROR", statusCode = 502) {
    super(message);
    this.name = "OpenDartError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class OpenDartClient {
  constructor({
    apiKey,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    timeoutMs = 10_000,
    cacheTtlMs = 60_000,
    maxPages = 3,
  }) {
    if (typeof apiKey !== "string" || apiKey.trim().length !== 40) {
      throw new TypeError("OpenDART API 인증키(40자리)가 필요합니다.");
    }
    if (typeof fetchImpl !== "function") throw new TypeError("fetch 구현이 필요합니다.");
    if (typeof now !== "function") throw new TypeError("now는 함수여야 합니다.");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs는 양수여야 합니다.");
    if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 10_000) throw new TypeError("cacheTtlMs는 10000 이상이어야 합니다.");
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10) throw new TypeError("maxPages는 1~10이어야 합니다.");
    this.apiKey = apiKey.trim();
    this.baseUrl = new URL(baseUrl);
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.cacheTtlMs = cacheTtlMs;
    this.maxPages = maxPages;
    this.cache = null;
    this.inFlight = null;
  }

  status() {
    return {
      enabled: true,
      state: this.inFlight ? "REFRESHING" : this.cache && this.now() < this.cache.expiresAt ? "READY" : "STALE",
      role: "공시 위험 필터",
      generatedAt: this.cache?.generatedAt ?? null,
      expiresAt: this.cache?.expiresAt ?? null,
    };
  }

  async getRecentDisclosures({ stockCodes = [], days = 3, force = false } = {}) {
    const normalizedCodes = [...new Set(stockCodes.map(normalizeStockCode).filter(Boolean))];
    if (normalizedCodes.length === 0) return new Map();
    const fresh = this.cache && this.now() < this.cache.expiresAt;
    if (!force && fresh) return selectCodes(this.cache.byStockCode, normalizedCodes);
    if (!this.inFlight) {
      this.inFlight = this.fetchRecentDisclosures(days).finally(() => {
        this.inFlight = null;
      });
    }
    const byStockCode = await this.inFlight;
    return selectCodes(byStockCode, normalizedCodes);
  }

  async fetchRecentDisclosures(days) {
    const dayCount = integerInRange(days, 1, 30, "days");
    const end = koreaDate(this.now());
    const start = koreaDate(this.now() - (dayCount - 1) * 86_400_000);
    const rows = [];
    for (let page = 1; page <= this.maxPages; page += 1) {
      const url = new URL("/api/list.json", this.baseUrl);
      url.searchParams.set("crtfc_key", this.apiKey);
      url.searchParams.set("bgn_de", start);
      url.searchParams.set("end_de", end);
      url.searchParams.set("page_no", String(page));
      url.searchParams.set("page_count", "100");
      url.searchParams.set("sort", "date");
      url.searchParams.set("sort_mth", "desc");
      const payload = await this.requestJson(url);
      const status = String(payload?.status ?? "");
      if (status === "013") break;
      if (status !== "000") {
        throw new OpenDartError(
          `OpenDART 공시검색이 거절되었습니다: ${safeMessage(payload?.message)}`,
          "OPENDART_REJECTED",
        );
      }
      const list = Array.isArray(payload.list) ? payload.list : [];
      rows.push(...list);
      const totalPage = Number(payload.total_page);
      if (!Number.isInteger(totalPage) || page >= totalPage) break;
    }
    const byStockCode = groupRows(rows, this.now());
    const generatedAt = this.now();
    this.cache = {
      generatedAt,
      expiresAt: generatedAt + this.cacheTtlMs,
      byStockCode,
    };
    return byStockCode;
  }

  async requestJson(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new OpenDartError("OpenDART 응답이 JSON이 아닙니다.", "OPENDART_INVALID_JSON");
      }
      if (!response.ok) {
        throw new OpenDartError("OpenDART HTTP 요청에 실패했습니다.", "OPENDART_HTTP_ERROR", response.status);
      }
      return payload;
    } catch (error) {
      if (error instanceof OpenDartError) throw error;
      throw new OpenDartError(
        error?.name === "AbortError" ? "OpenDART 요청 시간이 초과되었습니다." : "OpenDART 네트워크 요청에 실패했습니다.",
        error?.name === "AbortError" ? "OPENDART_TIMEOUT" : "OPENDART_NETWORK_ERROR",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createOpenDartClientFromEnv(env = process.env, options = {}) {
  const apiKey = String(env.PULSEHFT_DART_API_KEY ?? "").trim();
  if (!apiKey) return null;
  return new OpenDartClient({ apiKey, ...options });
}

export function classifyDisclosureRisk(items) {
  const matched = [];
  for (const item of Array.isArray(items) ? items : []) {
    const title = String(item?.reportName ?? "");
    const keyword = HIGH_RISK_PATTERNS.find((pattern) => title.includes(pattern));
    if (keyword) matched.push(`${keyword}: ${title}`);
  }
  return {
    level: matched.length > 0 ? "HIGH" : "NONE",
    reasons: matched.slice(0, 3),
  };
}

function groupRows(rows, fetchedAt) {
  const result = new Map();
  for (const row of rows) {
    const stockCode = normalizeStockCode(row?.stock_code);
    if (!stockCode) continue;
    const item = {
      receiptNumber: textOrNull(row.rcept_no),
      corporationName: textOrNull(row.corp_name),
      stockCode,
      reportName: textOrNull(row.report_nm) ?? "",
      filerName: textOrNull(row.flr_nm),
      receiptDate: textOrNull(row.rcept_dt),
      remarks: textOrNull(row.rm),
    };
    const current = result.get(stockCode) ?? [];
    current.push(item);
    result.set(stockCode, current);
  }
  const normalized = new Map();
  for (const [stockCode, items] of result) {
    const risk = classifyDisclosureRisk(items);
    normalized.set(stockCode, {
      enabled: true,
      fetchedAt,
      count: items.length,
      items: items.slice(0, 10),
      riskLevel: risk.level,
      riskReasons: risk.reasons,
    });
  }
  return normalized;
}

function selectCodes(source, stockCodes) {
  return new Map(stockCodes.map((code) => [code, source.get(code) ?? {
    enabled: true,
    fetchedAt: null,
    count: 0,
    items: [],
    riskLevel: "NONE",
    riskReasons: [],
  }]));
}

function normalizeStockCode(value) {
  const code = String(value ?? "").trim();
  return /^\d{6}$/.test(code) ? code : null;
}

function koreaDate(timestamp) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp)).replaceAll("-", "");
}

function integerInRange(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`${label}는 ${minimum} 이상 ${maximum} 이하의 정수여야 합니다.`);
  }
  return number;
}

function safeMessage(value) {
  const text = textOrNull(value);
  return text ? text.slice(0, 200) : "상세 메시지 없음";
}

function textOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}
