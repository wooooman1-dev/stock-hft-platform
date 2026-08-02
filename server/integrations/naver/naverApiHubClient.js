const DEFAULT_BASE_URL = "https://naverapihub.apigw.ntruss.com";

export class NaverApiHubError extends Error {
  constructor(message, code = "NAVER_API_HUB_ERROR", statusCode = 502) {
    super(message);
    this.name = "NaverApiHubError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class NaverApiHubClient {
  constructor({
    clientId,
    clientSecret,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    timeoutMs = 10_000,
    cacheTtlMs = 300_000,
  }) {
    if (typeof clientId !== "string" || !clientId.trim()) throw new TypeError("NAVER API HUB Client ID가 필요합니다.");
    if (typeof clientSecret !== "string" || !clientSecret.trim()) throw new TypeError("NAVER API HUB Client Secret이 필요합니다.");
    if (typeof fetchImpl !== "function") throw new TypeError("fetch 구현이 필요합니다.");
    if (typeof now !== "function") throw new TypeError("now는 함수여야 합니다.");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs는 양수여야 합니다.");
    if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 60_000) throw new TypeError("cacheTtlMs는 60000 이상이어야 합니다.");
    this.clientId = clientId.trim();
    this.clientSecret = clientSecret.trim();
    this.baseUrl = new URL(baseUrl);
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.cacheTtlMs = cacheTtlMs;
    this.cache = new Map();
  }

  status() {
    return {
      enabled: true,
      state: "READY",
      newsApiAvailable: true,
      cafeApiAvailable: true,
      cacheTtlMs: this.cacheTtlMs,
      role: "뉴스 재료 확인·커뮤니티 과열 참고",
    };
  }

  async getSignals({ symbol, name }) {
    const query = String(name ?? symbol ?? "").trim();
    if (!query) throw new NaverApiHubError("뉴스 검색어가 필요합니다.", "NAVER_QUERY_REQUIRED", 400);
    // 뉴스와 카페는 매수 신호가 아니라 보조 정보이며, 호출량 보호를 위해 캐시합니다.
    const news = await this.search("news", `${query} 주식`, { display: 5, sort: "date" });
    const community = await this.search("cafearticle", query, { display: 5, sort: "date" });
    return {
      fetchedAt: this.now(),
      news: normalizeSearchResult(news),
      community: normalizeSearchResult(community),
    };
  }

  async search(type, query, { display = 5, start = 1, sort = "date" } = {}) {
    if (!new Set(["news", "cafearticle"]).has(type)) {
      throw new NaverApiHubError("지원하지 않는 NAVER 검색 유형입니다.", "NAVER_SEARCH_TYPE_INVALID", 400);
    }
    const normalizedQuery = String(query ?? "").trim();
    if (!normalizedQuery) throw new NaverApiHubError("검색어가 필요합니다.", "NAVER_QUERY_REQUIRED", 400);
    const normalizedDisplay = integerInRange(display, 1, 100, "display");
    const normalizedStart = integerInRange(start, 1, 1000, "start");
    const normalizedSort = sort === "sim" ? "sim" : "date";
    const key = `${type}:${normalizedQuery}:${normalizedDisplay}:${normalizedStart}:${normalizedSort}`;
    const cached = this.cache.get(key);
    if (cached && this.now() < cached.expiresAt) return structuredClone(cached.value);

    const url = new URL(`/search/v1/${type}`, this.baseUrl);
    url.searchParams.set("query", normalizedQuery);
    url.searchParams.set("display", String(normalizedDisplay));
    url.searchParams.set("start", String(normalizedStart));
    url.searchParams.set("sort", normalizedSort);
    const value = await this.requestJson(url);
    this.cache.set(key, { value, expiresAt: this.now() + this.cacheTtlMs });
    return structuredClone(value);
  }

  async requestJson(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-NCP-APIGW-API-KEY-ID": this.clientId,
          "X-NCP-APIGW-API-KEY": this.clientSecret,
        },
        signal: controller.signal,
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new NaverApiHubError("NAVER API HUB 응답이 JSON이 아닙니다.", "NAVER_INVALID_JSON");
      }
      if (!response.ok) {
        throw new NaverApiHubError("NAVER API HUB HTTP 요청에 실패했습니다.", "NAVER_HTTP_ERROR", response.status);
      }
      return payload;
    } catch (error) {
      if (error instanceof NaverApiHubError) throw error;
      throw new NaverApiHubError(
        error?.name === "AbortError" ? "NAVER API HUB 요청 시간이 초과되었습니다." : "NAVER API HUB 네트워크 요청에 실패했습니다.",
        error?.name === "AbortError" ? "NAVER_TIMEOUT" : "NAVER_NETWORK_ERROR",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createNaverApiHubClientFromEnv(env = process.env, options = {}) {
  const clientId = String(env.PULSEHFT_NAVER_API_HUB_CLIENT_ID ?? "").trim();
  const clientSecret = String(env.PULSEHFT_NAVER_API_HUB_CLIENT_SECRET ?? "").trim();
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) throw new TypeError("NAVER API HUB Client ID와 Client Secret을 모두 설정해야 합니다.");
  return new NaverApiHubClient({ clientId, clientSecret, ...options });
}

function normalizeSearchResult(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return {
    total: finiteOrZero(payload?.total),
    returned: items.length,
    items: items.map((item) => ({
      title: stripHtml(item?.title),
      description: stripHtml(item?.description),
      link: safeHttpUrl(item?.originallink ?? item?.link),
      publishedAt: normalizeDate(item?.pubDate ?? item?.postdate),
      sourceName: stripHtml(item?.cafename),
    })),
  };
}

function stripHtml(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#39;", "'")
    .trim();
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizeDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  if (/^\d{8}$/.test(text)) return text;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function finiteOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function integerInRange(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`${label}는 ${minimum} 이상 ${maximum} 이하의 정수여야 합니다.`);
  }
  return number;
}
