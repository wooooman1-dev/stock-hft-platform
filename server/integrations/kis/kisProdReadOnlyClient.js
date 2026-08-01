import {
  KIS_MODE_PROD_READ_ONLY,
  publicKisConfiguration,
} from "./kisConfig.js";

const TOKEN_PATH = "/oauth2/tokenP";
const CURRENT_PRICE_PATH = "/uapi/domestic-stock/v1/quotations/inquire-price";
const CURRENT_PRICE_TR_ID = "FHKST01010100";
const ALLOWED_MARKETS = new Set(["J", "NX", "UN"]);

export class KisApiError extends Error {
  constructor(message, code = "KIS_API_ERROR", statusCode = 502) {
    super(message);
    this.name = "KisApiError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class KisProdReadOnlyClient {
  constructor({
    config,
    tokenStore,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    timeoutMs = 10_000,
  }) {
    if (config?.mode !== KIS_MODE_PROD_READ_ONLY || !config.enabled) {
      throw new TypeError("KIS PROD_READ_ONLY 설정이 필요합니다.");
    }
    if (!tokenStore || typeof tokenStore.loadValid !== "function" || typeof tokenStore.save !== "function") {
      throw new TypeError("유효한 KIS tokenStore가 필요합니다.");
    }
    if (typeof fetchImpl !== "function") throw new TypeError("fetch 구현이 필요합니다.");
    if (typeof now !== "function") throw new TypeError("now는 함수여야 합니다.");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs는 양수여야 합니다.");

    this.config = config;
    this.tokenStore = tokenStore;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.tokenRequest = null;
  }

  status() {
    return {
      ...publicKisConfiguration(this.config),
      token: this.tokenStore.status(),
      quoteApiAvailable: true,
    };
  }

  async getCurrentPrice({ symbol, market = "UN" }) {
    const normalizedSymbol = normalizeSymbol(symbol);
    const normalizedMarket = normalizeMarket(market);
    const accessToken = await this.getAccessToken();
    const url = new URL(CURRENT_PRICE_PATH, this.config.baseUrl);
    url.searchParams.set("FID_COND_MRKT_DIV_CODE", normalizedMarket);
    url.searchParams.set("FID_INPUT_ISCD", normalizedSymbol);

    const response = await this.request(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/plain",
        charset: "UTF-8",
        authorization: `Bearer ${accessToken}`,
        appkey: this.config.appKey,
        appsecret: this.config.appSecret,
        tr_id: CURRENT_PRICE_TR_ID,
        custtype: "P",
      },
    });
    const payload = await parseJson(response, "현재가 조회");
    if (!response.ok) {
      throw apiFailure("현재가 조회", response.status, payload, "KIS_QUOTE_HTTP_ERROR");
    }
    if (String(payload?.rt_cd ?? "") !== "0") {
      throw apiFailure("현재가 조회", 502, payload, "KIS_QUOTE_REJECTED");
    }
    if (!isRecord(payload.output)) {
      throw new KisApiError(
        "한국투자 현재가 응답에 output 객체가 없습니다.",
        "KIS_QUOTE_INVALID_RESPONSE",
      );
    }

    return normalizeCurrentPrice(payload.output, {
      symbol: normalizedSymbol,
      market: normalizedMarket,
      fetchedAt: this.now(),
    });
  }

  async getAccessToken() {
    const cached = this.tokenStore.loadValid();
    if (cached) return cached.accessToken;
    if (!this.tokenRequest) {
      this.tokenRequest = this.issueAccessToken().finally(() => {
        this.tokenRequest = null;
      });
    }
    return this.tokenRequest;
  }

  async issueAccessToken() {
    const response = await this.request(new URL(TOKEN_PATH, this.config.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/plain",
        charset: "UTF-8",
      },
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: this.config.appKey,
        appsecret: this.config.appSecret,
      }),
    });
    const payload = await parseJson(response, "접근토큰 발급");
    if (!response.ok) {
      throw apiFailure("접근토큰 발급", response.status, payload, "KIS_TOKEN_HTTP_ERROR");
    }

    const accessToken = typeof payload?.access_token === "string" ? payload.access_token : "";
    const expiresInSeconds = Number(payload?.expires_in);
    if (!accessToken || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
      throw new KisApiError(
        "한국투자 접근토큰 응답 형식이 올바르지 않습니다.",
        "KIS_TOKEN_INVALID_RESPONSE",
      );
    }

    const issuedAt = this.now();
    const stored = this.tokenStore.save({
      accessToken,
      tokenType: typeof payload.token_type === "string" && payload.token_type
        ? payload.token_type
        : "Bearer",
      issuedAt,
      expiresAt: issuedAt + expiresInSeconds * 1_000,
    });
    return stored.accessToken;
  }

  async request(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...options, signal: controller.signal });
    } catch (error) {
      const timeoutFailure = error?.name === "AbortError";
      throw new KisApiError(
        timeoutFailure
          ? "한국투자 API 요청 시간이 초과되었습니다."
          : `한국투자 API 네트워크 요청에 실패했습니다: ${formatError(error)}`,
        timeoutFailure ? "KIS_REQUEST_TIMEOUT" : "KIS_NETWORK_ERROR",
        502,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeCurrentPrice(output, { symbol, market, fetchedAt }) {
  return {
    source: "KIS",
    mode: KIS_MODE_PROD_READ_ONLY,
    environment: "PROD",
    currency: "KRW",
    symbol,
    market,
    fetchedAt,
    marketName: textOrNull(output.rprs_mrkt_kor_name),
    currentPrice: numberOrNull(output.stck_prpr),
    previousChange: numberOrNull(output.prdy_vrss),
    previousChangeSign: textOrNull(output.prdy_vrss_sign),
    changePercent: numberOrNull(output.prdy_ctrt),
    accumulatedVolume: numberOrNull(output.acml_vol),
    accumulatedTradingValue: numberOrNull(output.acml_tr_pbmn),
    openPrice: numberOrNull(output.stck_oprc),
    highPrice: numberOrNull(output.stck_hgpr),
    lowPrice: numberOrNull(output.stck_lwpr),
    upperLimitPrice: numberOrNull(output.stck_mxpr),
    lowerLimitPrice: numberOrNull(output.stck_llam),
    basePrice: numberOrNull(output.stck_sdpr),
    askUnit: numberOrNull(output.aspr_unit),
    tradingHalted: output.temp_stop_yn === "Y",
  };
}

function normalizeSymbol(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  if (!/^(?:\d{6}|Q\d{6})$/.test(symbol)) {
    throw new KisApiError(
      "symbol은 6자리 종목코드 또는 Q로 시작하는 ETN 코드여야 합니다.",
      "KIS_INVALID_SYMBOL",
      400,
    );
  }
  return symbol;
}

function normalizeMarket(value) {
  const market = String(value ?? "UN").trim().toUpperCase();
  if (!ALLOWED_MARKETS.has(market)) {
    throw new KisApiError(
      "market은 J(KRX), NX(NXT), UN(통합) 중 하나여야 합니다.",
      "KIS_INVALID_MARKET",
      400,
    );
  }
  return market;
}

async function parseJson(response, operation) {
  try {
    return await response.json();
  } catch {
    throw new KisApiError(
      `한국투자 ${operation} 응답이 JSON이 아닙니다.`,
      "KIS_INVALID_JSON_RESPONSE",
    );
  }
}

function apiFailure(operation, status, payload, code) {
  const message = firstText(payload?.msg1, payload?.error_description, payload?.message);
  return new KisApiError(
    `한국투자 ${operation} 실패${message ? `: ${message}` : ""}`,
    code,
    Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502,
  );
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(number) ? number : null;
}

function textOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function firstText(...values) {
  for (const value of values) {
    const text = textOrNull(value);
    if (text) return text;
  }
  return null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
