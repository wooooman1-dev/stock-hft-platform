import {
  KIS_PAPER_MODE_TRADING,
  publicKisPaperConfiguration,
} from "./kisPaperConfig.js";
import {
  KisPaperApiError,
  apiFailure,
  assertSuccessfulPayload,
  formatError,
  invalidInput,
  normalizeBalancePages,
  normalizeDailyOrderHistory,
  normalizeOrderInput,
  normalizeOrderResponse,
  normalizeReviseCancelInput,
  normalizeSymbol,
  parseJson,
  redactText,
  textOrEmpty,
} from "./kisPaperTradingSupport.js";

export { KisPaperApiError } from "./kisPaperTradingSupport.js";

const TOKEN_PATH = "/oauth2/tokenP";
const BALANCE_PATH = "/uapi/domestic-stock/v1/trading/inquire-balance";
const ORDER_CASH_PATH = "/uapi/domestic-stock/v1/trading/order-cash";
const ORDER_REVISE_CANCEL_PATH = "/uapi/domestic-stock/v1/trading/order-rvsecncl";
const DAILY_ORDERS_PATH = "/uapi/domestic-stock/v1/trading/inquire-daily-ccld";
const BALANCE_TR_ID = "VTTC8434R";
const BUY_TR_ID = "VTTC0012U";
const SELL_TR_ID = "VTTC0011U";
const REVISE_CANCEL_TR_ID = "VTTC0013U";
const DAILY_ORDERS_TR_ID = "VTTC0081R";
const CONTINUATION_HEADERS = new Set(["M", "F"]);
const HISTORY_EXCHANGES = new Set(["KRX", "NXT", "SOR", "ALL"]);
const DEFAULT_REQUEST_SPACING_MS = 650;
const DEFAULT_READ_RETRY_DELAY_MS = 1_200;
const DEFAULT_DAILY_ORDERS_CACHE_MS = 1_000;
const KIS_RATE_LIMIT_CODE = "EGW00201";

export class KisPaperTradingClient {
  constructor({
    config,
    tokenStore,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    timeoutMs = 10_000,
    requestSpacingMs = DEFAULT_REQUEST_SPACING_MS,
    readRetryDelayMs = DEFAULT_READ_RETRY_DELAY_MS,
    dailyOrdersCacheMs = DEFAULT_DAILY_ORDERS_CACHE_MS,
  }) {
    if (config?.mode !== KIS_PAPER_MODE_TRADING || !config.enabled) {
      throw new TypeError("KIS PAPER_TRADING 설정이 필요합니다.");
    }
    if (!tokenStore || typeof tokenStore.loadValid !== "function" || typeof tokenStore.save !== "function") {
      throw new TypeError("유효한 KIS paper tokenStore가 필요합니다.");
    }
    if (typeof fetchImpl !== "function") throw new TypeError("fetch 구현이 필요합니다.");
    if (typeof now !== "function") throw new TypeError("now는 함수여야 합니다.");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs는 양수여야 합니다.");
    this.config = config;
    this.tokenStore = tokenStore;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.requestSpacingMs = nonNegativeInteger(requestSpacingMs, "requestSpacingMs");
    this.readRetryDelayMs = nonNegativeInteger(readRetryDelayMs, "readRetryDelayMs");
    this.dailyOrdersCacheMs = nonNegativeInteger(dailyOrdersCacheMs, "dailyOrdersCacheMs");
    this.tokenRequest = null;
    this.requestQueue = Promise.resolve();
    this.lastAuthorizedRequestStartedAt = 0;
    this.dailyOrdersRequests = new Map();
    this.dailyOrdersCache = new Map();
    this.dailyOrdersCacheGeneration = 0;
  }

  status() {
    return {
      ...publicKisPaperConfiguration(this.config),
      token: this.tokenStore.status(),
      balanceApiAvailable: true,
      orderApiAvailable: true,
      orderHistoryApiAvailable: true,
      cancelableOrderSource: "DAILY_ORDER_HISTORY",
      requestSpacingMs: this.requestSpacingMs,
      readRateLimitRetry: true,
    };
  }

  async getBalance() {
    const pages = [];
    let fk100 = "";
    let nk100 = "";
    let trCont = "";
    for (let page = 0; page < 10; page += 1) {
      const url = new URL(BALANCE_PATH, this.config.baseUrl);
      const params = {
        CANO: this.config.accountNumber,
        ACNT_PRDT_CD: this.config.accountProductCode,
        AFHR_FLPR_YN: "N",
        OFL_YN: "",
        INQR_DVSN: "02",
        UNPR_DVSN: "01",
        FUND_STTL_ICLD_YN: "N",
        FNCG_AMT_AUTO_RDPT_YN: "N",
        PRCS_DVSN: "00",
        CTX_AREA_FK100: fk100,
        CTX_AREA_NK100: nk100,
      };
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const { response, payload } = await this.authorizedRequest("잔고 조회", url, {
        method: "GET",
        trId: BALANCE_TR_ID,
        trCont,
        ambiguousOnFailure: false,
      });
      assertSuccessfulPayload("잔고 조회", response, payload, {
        code: "KIS_PAPER_BALANCE_REJECTED",
        secrets: this.secrets(),
      });
      pages.push(payload);
      const continuation = continuationHeader(response);
      if (!CONTINUATION_HEADERS.has(continuation)) break;
      fk100 = textOrEmpty(payload?.ctx_area_fk100);
      nk100 = textOrEmpty(payload?.ctx_area_nk100);
      trCont = "N";
      if (!fk100 && !nk100) break;
    }
    return normalizeBalancePages(pages, this.now());
  }

  async getCancelableOrders() {
    const history = await this.getDailyOrders({ execution: "ALL" });
    return history.orders
      .filter((order) => Number(order?.remainingQuantity) > 0
        && !new Set(["FILLED", "CANCELED", "REJECTED"]).has(String(order?.status ?? "").toUpperCase()))
      .map(cancelableOrderFromDailyHistory);
  }

  async getDailyOrders(input = {}) {
    const startDate = input.startDate ?? koreaDate(this.now());
    const query = normalizeOrderHistoryQuery({
      startDate,
      endDate: input.endDate ?? startDate,
      side: input.side ?? "ALL",
      execution: input.execution ?? "ALL",
      symbol: input.symbol ?? "",
      orderOrganizationNumber: input.orderOrganizationNumber ?? "",
      orderNumber: input.orderNumber ?? "",
      exchange: input.exchange ?? "ALL",
    });
    const key = JSON.stringify(query);
    const cached = this.dailyOrdersCache.get(key);
    if (cached && this.dailyOrdersCacheMs > 0
      && Date.now() - cached.cachedAt <= this.dailyOrdersCacheMs) {
      return structuredClone(cached.value);
    }
    const pending = this.dailyOrdersRequests.get(key);
    if (pending) return structuredClone(await pending);

    const generation = this.dailyOrdersCacheGeneration;
    const request = this.fetchDailyOrders(query)
      .then((history) => {
        if (generation === this.dailyOrdersCacheGeneration && this.dailyOrdersCacheMs > 0) {
          this.dailyOrdersCache.set(key, {
            cachedAt: Date.now(),
            value: structuredClone(history),
          });
        }
        return history;
      })
      .finally(() => {
        if (this.dailyOrdersRequests.get(key) === request) {
          this.dailyOrdersRequests.delete(key);
        }
      });
    this.dailyOrdersRequests.set(key, request);
    return structuredClone(await request);
  }

  async fetchDailyOrders(query) {
    const pages = [];
    let fk100 = "";
    let nk100 = "";
    let trCont = "";
    for (let page = 0; page < 10; page += 1) {
      const url = new URL(DAILY_ORDERS_PATH, this.config.baseUrl);
      const params = {
        CANO: this.config.accountNumber,
        ACNT_PRDT_CD: this.config.accountProductCode,
        INQR_STRT_DT: query.startDate,
        INQR_END_DT: query.endDate,
        SLL_BUY_DVSN_CD: query.sideCode,
        PDNO: query.symbol,
        CCLD_DVSN: query.executionCode,
        INQR_DVSN: "00",
        INQR_DVSN_3: "00",
        ORD_GNO_BRNO: query.orderOrganizationNumber,
        ODNO: query.orderNumber,
        INQR_DVSN_1: "",
        CTX_AREA_FK100: fk100,
        CTX_AREA_NK100: nk100,
        EXCG_ID_DVSN_CD: query.exchange,
      };
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const { response, payload } = await this.authorizedRequest("주문·체결내역 조회", url, {
        method: "GET",
        trId: DAILY_ORDERS_TR_ID,
        trCont,
        ambiguousOnFailure: false,
      });
      assertSuccessfulPayload("주문·체결내역 조회", response, payload, {
        code: "KIS_PAPER_ORDER_HISTORY_REJECTED",
        secrets: this.secrets(),
      });
      pages.push(payload);
      const continuation = continuationHeader(response);
      if (!CONTINUATION_HEADERS.has(continuation)) break;
      fk100 = textOrEmpty(payload?.ctx_area_fk100);
      nk100 = textOrEmpty(payload?.ctx_area_nk100);
      trCont = "N";
      if (!fk100 && !nk100) break;
    }
    return normalizeDailyOrderHistory(pages, this.now());
  }

  async submitOrder(input) {
    const order = normalizeOrderInput(input);
    const body = {
      CANO: this.config.accountNumber,
      ACNT_PRDT_CD: this.config.accountProductCode,
      PDNO: order.symbol,
      ORD_DVSN: order.type === "MARKET" ? "01" : "00",
      ORD_QTY: String(order.quantity),
      ORD_UNPR: order.type === "MARKET" ? "0" : String(order.limitPrice),
      EXCG_ID_DVSN_CD: order.exchange,
      SLL_TYPE: order.side === "SELL" ? "01" : "",
      CNDT_PRIC: "",
    };
    const trId = order.side === "BUY" ? BUY_TR_ID : SELL_TR_ID;
    const { response, payload } = await this.authorizedRequest("모의주문", new URL(ORDER_CASH_PATH, this.config.baseUrl), {
      method: "POST",
      trId,
      body,
      ambiguousOnFailure: true,
    });
    assertSuccessfulPayload("모의주문", response, payload, {
      code: "KIS_PAPER_ORDER_REJECTED",
      secrets: this.secrets(),
      ambiguousHttp5xx: true,
    });
    this.invalidateDailyOrdersCache();
    return normalizeOrderResponse(payload.output, {
      operation: "SUBMIT",
      side: order.side,
      symbol: order.symbol,
      type: order.type,
      quantity: order.quantity,
      limitPrice: order.limitPrice,
      exchange: order.exchange,
      acceptedAt: this.now(),
    });
  }

  async reviseOrder(input) {
    const request = normalizeReviseCancelInput(input, "REVISE");
    await this.assertCancelable(request);
    return this.executeReviseCancel(request, "01");
  }

  async cancelOrder(input) {
    const request = normalizeReviseCancelInput(input, "CANCEL");
    const match = await this.assertCancelable(request);
    const resolved = {
      ...request,
      type: request.type ?? (match.orderDivision === "00" ? "LIMIT" : "MARKET"),
      limitPrice: request.limitPrice ?? (match.orderDivision === "00" ? match.orderPrice : null),
    };
    return this.executeReviseCancel(resolved, "02");
  }

  async assertCancelable(request) {
    const cancelable = await this.getCancelableOrders();
    const match = cancelable.find((order) => (
      order.orderNumber === request.originalOrderNumber
      && (!request.orderOrganizationNumber
        || order.orderOrganizationNumber === request.orderOrganizationNumber)
    ));
    if (!match) {
      throw new KisPaperApiError("한국투자 모의계좌에서 정정·취소 가능한 원주문을 찾을 수 없습니다.", {
        code: "KIS_PAPER_ORDER_NOT_CANCELABLE",
        statusCode: 409,
        ambiguous: false,
        operation: request.operation,
      });
    }
    if (request.quantity > match.cancelableQuantity) {
      throw new KisPaperApiError(`정정·취소 수량은 가능 수량 ${match.cancelableQuantity}주를 초과할 수 없습니다.`, {
        code: "KIS_PAPER_CANCEL_QUANTITY_EXCEEDED",
        statusCode: 409,
        ambiguous: false,
        operation: request.operation,
      });
    }
    return match;
  }

  async executeReviseCancel(request, divisionCode) {
    const body = {
      CANO: this.config.accountNumber,
      ACNT_PRDT_CD: this.config.accountProductCode,
      KRX_FWDG_ORD_ORGNO: request.orderOrganizationNumber,
      ORGN_ODNO: request.originalOrderNumber,
      ORD_DVSN: request.type === "MARKET" ? "01" : "00",
      RVSE_CNCL_DVSN_CD: divisionCode,
      ORD_QTY: String(request.quantity),
      ORD_UNPR: request.type === "MARKET" ? "0" : String(request.limitPrice),
      QTY_ALL_ORD_YN: request.allQuantity ? "Y" : "N",
      EXCG_ID_DVSN_CD: request.exchange,
      CNDT_PRIC: "",
    };
    const operationLabel = request.operation === "REVISE" ? "모의주문 정정" : "모의주문 취소";
    const { response, payload } = await this.authorizedRequest(
      operationLabel,
      new URL(ORDER_REVISE_CANCEL_PATH, this.config.baseUrl),
      {
        method: "POST",
        trId: REVISE_CANCEL_TR_ID,
        body,
        ambiguousOnFailure: true,
      },
    );
    assertSuccessfulPayload(operationLabel, response, payload, {
      code: request.operation === "REVISE" ? "KIS_PAPER_REVISE_REJECTED" : "KIS_PAPER_CANCEL_REJECTED",
      secrets: this.secrets(),
      ambiguousHttp5xx: true,
    });
    this.invalidateDailyOrdersCache();
    return normalizeOrderResponse(payload.output, {
      operation: request.operation,
      originalOrderNumber: request.originalOrderNumber,
      quantity: request.quantity,
      limitPrice: request.limitPrice,
      exchange: request.exchange,
      acceptedAt: this.now(),
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
    const response = await this.rawRequest("접근토큰 발급", new URL(TOKEN_PATH, this.config.baseUrl), {
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
      ambiguousOnFailure: false,
    });
    const payload = await parseJson(response, "접근토큰 발급", false);
    if (!response.ok) {
      throw apiFailure("접근토큰 발급", response.status, payload, {
        code: "KIS_PAPER_TOKEN_HTTP_ERROR",
        secrets: this.secrets(false),
      });
    }
    const accessToken = typeof payload?.access_token === "string" ? payload.access_token : "";
    const expiresInSeconds = Number(payload?.expires_in);
    if (!accessToken || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
      throw new KisPaperApiError("한국투자 모의투자 접근토큰 응답 형식이 올바르지 않습니다.", {
        code: "KIS_PAPER_TOKEN_INVALID_RESPONSE",
      });
    }
    const issuedAt = this.now();
    const stored = this.tokenStore.save({
      accessToken,
      tokenType: typeof payload.token_type === "string" && payload.token_type ? payload.token_type : "Bearer",
      issuedAt,
      expiresAt: issuedAt + expiresInSeconds * 1_000,
    });
    return stored.accessToken;
  }

  async authorizedRequest(operation, url, {
    method,
    trId,
    trCont = "",
    body = null,
    ambiguousOnFailure,
  }) {
    const accessToken = await this.getAccessToken();
    const headers = {
      "Content-Type": "application/json",
      Accept: "text/plain",
      charset: "UTF-8",
      authorization: `Bearer ${accessToken}`,
      appkey: this.config.appKey,
      appsecret: this.config.appSecret,
      tr_id: trId,
      tr_cont: trCont,
      custtype: "P",
    };
    const requestOptions = {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      ambiguousOnFailure,
    };
    const attempts = String(method).toUpperCase() === "GET" ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await this.enqueueAuthorizedRequest(async () => {
        const response = await this.rawRequest(operation, url, requestOptions);
        const payload = await parseJson(response, operation, Boolean(ambiguousOnFailure));
        return { response, payload };
      });
      if (attempt + 1 < attempts && isRateLimited(result.response, result.payload)) {
        await delay(this.readRetryDelayMs);
        continue;
      }
      return result;
    }
    throw new Error("KIS authorized request retry loop ended unexpectedly.");
  }

  async enqueueAuthorizedRequest(task) {
    const run = this.requestQueue.then(async () => {
      const elapsed = Date.now() - this.lastAuthorizedRequestStartedAt;
      const waitMs = Math.max(0, this.requestSpacingMs - elapsed);
      if (waitMs > 0) await delay(waitMs);
      this.lastAuthorizedRequestStartedAt = Date.now();
      return task();
    });
    this.requestQueue = run.catch(() => {});
    return run;
  }

  invalidateDailyOrdersCache() {
    this.dailyOrdersCacheGeneration += 1;
    this.dailyOrdersCache.clear();
    this.dailyOrdersRequests.clear();
  }

  async rawRequest(operation, url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...options, signal: controller.signal });
    } catch (error) {
      const timeoutFailure = error?.name === "AbortError";
      const safeDetail = redactText(formatError(error), this.secrets());
      throw new KisPaperApiError(
        timeoutFailure
          ? `한국투자 ${operation} 요청 시간이 초과되었습니다.`
          : `한국투자 ${operation} 네트워크 요청에 실패했습니다: ${safeDetail}`,
        {
          code: timeoutFailure ? "KIS_PAPER_REQUEST_TIMEOUT" : "KIS_PAPER_NETWORK_ERROR",
          statusCode: 502,
          ambiguous: Boolean(options.ambiguousOnFailure),
          operation,
        },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  secrets(includeAccount = true) {
    const values = [this.config.appKey, this.config.appSecret];
    if (includeAccount) values.push(this.config.accountNumber);
    try {
      const token = this.tokenStore.loadValid?.();
      if (token?.accessToken) values.push(token.accessToken);
    } catch {
      // Redaction must never hide the original API/network failure.
    }
    return values;
  }
}

function cancelableOrderFromDailyHistory(order) {
  return {
    source: "KIS",
    mode: KIS_PAPER_MODE_TRADING,
    environment: "PAPER",
    orderOrganizationNumber: order?.orderOrganizationNumber ?? null,
    orderNumber: order?.orderNumber ?? null,
    symbol: order?.symbol ?? null,
    name: order?.name ?? null,
    side: order?.side ?? null,
    orderQuantity: Number(order?.orderQuantity) || 0,
    executedQuantity: Number(order?.executedQuantity) || 0,
    cancelableQuantity: Number(order?.remainingQuantity) || 0,
    orderPrice: Number(order?.orderPrice) || 0,
    orderDivision: order?.orderDivisionCode ?? null,
  };
}

function continuationHeader(response) {
  return String(response.headers.get("tr_cont") ?? "").trim().toUpperCase();
}

function isRateLimited(response, payload) {
  const code = String(payload?.msg_cd ?? payload?.msgCode ?? payload?.code ?? "").trim().toUpperCase();
  const message = String(payload?.msg1 ?? payload?.message ?? payload?.msg ?? "").trim();
  return response?.status === 429
    || code === KIS_RATE_LIMIT_CODE
    || message.includes("초당 거래건수");
}

function delay(milliseconds) {
  if (!milliseconds) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function koreaDate(timestamp) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}`;
}

function normalizeOrderHistoryQuery(input) {
  const startDate = normalizeDate(input.startDate, "startDate");
  const endDate = normalizeDate(input.endDate, "endDate");
  if (startDate > endDate) throw invalidInput("startDate는 endDate보다 늦을 수 없습니다.");
  const side = String(input.side ?? "ALL").trim().toUpperCase();
  const sideCode = { ALL: "00", SELL: "01", BUY: "02" }[side];
  if (!sideCode) throw invalidInput("side는 ALL, BUY, SELL 중 하나여야 합니다.");
  const execution = String(input.execution ?? "ALL").trim().toUpperCase();
  const executionCode = { ALL: "00", FILLED: "01", OPEN: "02" }[execution];
  if (!executionCode) throw invalidInput("execution은 ALL, FILLED, OPEN 중 하나여야 합니다.");
  const rawSymbol = String(input.symbol ?? "").trim();
  const symbol = rawSymbol ? normalizeSymbol(rawSymbol) : "";
  const orderOrganizationNumber = optionalDigits(input.orderOrganizationNumber, "orderOrganizationNumber");
  const orderNumber = optionalDigits(input.orderNumber, "orderNumber");
  const exchange = String(input.exchange ?? "ALL").trim().toUpperCase();
  if (!HISTORY_EXCHANGES.has(exchange)) {
    throw invalidInput("exchange는 KRX, NXT, SOR, ALL 중 하나여야 합니다.");
  }
  return {
    startDate,
    endDate,
    sideCode,
    executionCode,
    symbol,
    orderOrganizationNumber,
    orderNumber,
    exchange,
  };
}

function normalizeDate(value, field) {
  const text = String(value ?? "").trim();
  if (!/^\d{8}$/.test(text)) throw invalidInput(`${field}는 YYYYMMDD 형식이어야 합니다.`);
  return text;
}

function optionalDigits(value, field) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (!/^\d+$/.test(text)) throw invalidInput(`${field}는 숫자 문자열이어야 합니다.`);
  return text;
}

function nonNegativeInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new TypeError(`${field}는 0 이상의 정수여야 합니다.`);
  }
  return number;
}
