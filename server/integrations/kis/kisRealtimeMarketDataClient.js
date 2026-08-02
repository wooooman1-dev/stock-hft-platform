import { EventEmitter } from "node:events";
import { KIS_MODE_PROD_READ_ONLY } from "./kisConfig.js";

const APPROVAL_PATH = "/oauth2/Approval";
const PROD_WEBSOCKET_URL = "ws://ops.koreainvestment.com:21000/tryitout";
const APPROVAL_MAX_AGE_MS = 23 * 60 * 60 * 1_000;

export const KIS_REALTIME_TR = Object.freeze({
  KRX: Object.freeze({ orderBook: "H0STASP0", trade: "H0STCNT0" }),
  NXT: Object.freeze({ orderBook: "H0NXASP0", trade: "H0NXCNT0" }),
  UNIFIED: Object.freeze({ orderBook: "H0UNASP0", trade: "H0UNCNT0" }),
});

const ORDER_BOOK_COLUMNS = Object.freeze([
  "symbol", "businessTime", "hourClassCode",
  ...range("askPrice"), ...range("bidPrice"), ...range("askSize"), ...range("bidSize"),
  "totalAskSize", "totalBidSize", "overtimeTotalAskSize", "overtimeTotalBidSize",
  "anticipatedPrice", "anticipatedQuantity", "anticipatedVolume", "anticipatedChange",
  "anticipatedChangeSign", "anticipatedChangePercent", "accumulatedVolume",
  "totalAskSizeChange", "totalBidSizeChange", "overtimeTotalAskChange",
  "overtimeTotalBidChange", "dealClassCode",
]);
const EXTENDED_ORDER_BOOK_COLUMNS = Object.freeze([
  ...ORDER_BOOK_COLUMNS,
  "krxMidPrice", "krxMidTotalSize", "krxMidClassCode",
  "nxtMidPrice", "nxtMidTotalSize", "nxtMidClassCode",
]);
const TRADE_COLUMNS = Object.freeze([
  "symbol", "tradeTime", "currentPrice", "previousChangeSign", "previousChange",
  "changePercent", "weightedAveragePrice", "openPrice", "highPrice", "lowPrice",
  "bestAsk", "bestBid", "tradeVolume", "accumulatedVolume", "accumulatedTradingValue",
  "sellTradeCount", "buyTradeCount", "netBuyTradeCount", "executionStrength",
  "totalSellQuantity", "totalBuyQuantity", "tradeClassCode", "buyRatio",
  "previousSameTimeVolumeRatio", "openTime", "openVsCurrentSign", "openVsCurrent",
  "highTime", "highVsCurrentSign", "highVsCurrent", "lowTime", "lowVsCurrentSign",
  "lowVsCurrent", "businessDate", "newMarketOperationClassCode", "tradingHalt",
  "bestAskSize", "bestBidSize", "totalAskSize", "totalBidSize", "turnoverRate",
  "previousSameTimeVolume", "previousSameTimeVolumeRate", "hourClassCode",
  "marketTradingTimeClassCode", "viStandardPrice",
]);
const TR_SCHEMAS = new Map(Object.entries(KIS_REALTIME_TR).flatMap(([venue, ids]) => [
  [ids.orderBook, { venue, type: "ORDER_BOOK", columns: venue === "KRX" ? ORDER_BOOK_COLUMNS : EXTENDED_ORDER_BOOK_COLUMNS }],
  [ids.trade, { venue, type: "TRADE", columns: TRADE_COLUMNS }],
]));

export class KisRealtimeError extends Error {
  constructor(message, code = "KIS_REALTIME_ERROR", statusCode = 502) {
    super(message);
    this.name = "KisRealtimeError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class KisRealtimeMarketDataClient extends EventEmitter {
  constructor({
    config,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    now = Date.now,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    timeoutMs = 10_000,
    staleAfterMs = 5_000,
    reconnectBaseMs = 1_000,
    reconnectMaxMs = 30_000,
    maxSymbols = 8,
    websocketUrl = PROD_WEBSOCKET_URL,
  } = {}) {
    super();
    if (config?.mode !== KIS_MODE_PROD_READ_ONLY || !config.enabled) {
      throw new TypeError("KIS PROD_READ_ONLY 설정이 필요합니다.");
    }
    if (typeof fetchImpl !== "function") throw new TypeError("fetch 구현이 필요합니다.");
    if (typeof WebSocketImpl !== "function") throw new TypeError("WebSocket 구현이 필요합니다.");
    if (typeof now !== "function") throw new TypeError("now는 함수여야 합니다.");
    if (!Number.isInteger(maxSymbols) || maxSymbols < 1 || maxSymbols > 20) {
      throw new TypeError("maxSymbols는 1~20 정수여야 합니다.");
    }
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.timeoutMs = positiveInteger(timeoutMs, "timeoutMs");
    this.staleAfterMs = positiveInteger(staleAfterMs, "staleAfterMs");
    this.reconnectBaseMs = positiveInteger(reconnectBaseMs, "reconnectBaseMs");
    this.reconnectMaxMs = positiveInteger(reconnectMaxMs, "reconnectMaxMs");
    this.maxSymbols = maxSymbols;
    this.websocketUrl = normalizeWebSocketUrl(websocketUrl);
    this.state = "IDLE";
    this.started = false;
    this.socket = null;
    this.connectPromise = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.approvalKey = null;
    this.approvalIssuedAt = null;
    this.approvalRequest = null;
    this.desired = new Map();
    this.activeSubscriptions = new Set();
    this.marketData = new Map();
    this.lastConnectedAt = null;
    this.lastDisconnectedAt = null;
    this.lastMessageAt = null;
    this.lastError = null;
  }

  status() {
    const freshest = [...this.marketData.values()].reduce(
      (maximum, item) => Math.max(maximum, item.orderBook?.receivedAt ?? 0, item.trade?.receivedAt ?? 0),
      0,
    );
    return {
      enabled: true,
      mode: KIS_MODE_PROD_READ_ONLY,
      state: this.state,
      connected: this.state === "CONNECTED" && isOpen(this.socket),
      websocketHost: new URL(this.websocketUrl).host,
      desiredSymbolCount: this.desired.size,
      activeSubscriptionCount: this.activeSubscriptions.size,
      maxSymbols: this.maxSymbols,
      staleAfterMs: this.staleAfterMs,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      lastMessageAt: this.lastMessageAt,
      freshestDataAgeMs: freshest > 0 ? Math.max(0, this.now() - freshest) : null,
      reconnectAttempt: this.reconnectAttempt,
      lastError: this.lastError ? { ...this.lastError } : null,
      trIds: structuredClone(KIS_REALTIME_TR),
      automaticOrderConnected: false,
    };
  }

  watchSymbols(items) {
    const next = normalizeWatchItems(items, this.maxSymbols);
    const previous = this.desired;
    this.desired = next;
    if (isOpen(this.socket)) {
      for (const [key, item] of previous) if (!next.has(key)) this.sendVenueSubscriptions(item, "0");
      for (const [key, item] of next) if (!previous.has(key)) this.sendVenueSubscriptions(item, "1");
    }
    if (!this.started) this.start();
    else void this.ensureConnected();
    return this.status();
  }

  start() {
    if (this.started) return this.status();
    this.started = true;
    if (this.state === "STOPPED") this.state = "IDLE";
    void this.ensureConnected();
    return this.status();
  }

  stop() {
    this.started = false;
    if (this.reconnectTimer) this.clearTimeoutImpl(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.connectPromise = null;
    this.activeSubscriptions.clear();
    if (socket && (isOpen(socket) || isConnecting(socket))) {
      try { socket.close(1000, "PulseHFT shutdown"); } catch { /* no-op */ }
    }
    this.state = "STOPPED";
    this.emit("status", this.status());
  }

  snapshot(symbol) {
    const normalizedSymbol = normalizeSymbol(symbol);
    const item = this.marketData.get(normalizedSymbol) ?? {};
    const orderBookAgeMs = age(this.now(), item.orderBook?.receivedAt);
    const tradeAgeMs = age(this.now(), item.trade?.receivedAt);
    const latestAt = Math.max(item.orderBook?.receivedAt ?? 0, item.trade?.receivedAt ?? 0) || null;
    return structuredClone({
      symbol: normalizedSymbol,
      connectionState: this.state,
      connected: this.state === "CONNECTED" && isOpen(this.socket),
      venue: item.venue ?? this.findDesiredVenue(normalizedSymbol),
      orderBook: item.orderBook ?? null,
      trade: item.trade ?? null,
      orderBookAgeMs,
      tradeAgeMs,
      latestAt,
      stale: latestAt === null || this.now() - latestAt > this.staleAfterMs,
      staleAfterMs: this.staleAfterMs,
      automaticOrderConnected: false,
    });
  }

  async ensureConnected() {
    if (!this.started || this.desired.size === 0 || isOpen(this.socket)) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connect().finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  async connect() {
    this.setState(this.reconnectAttempt > 0 ? "RECONNECTING" : "CONNECTING");
    let approvalKey;
    try {
      approvalKey = await this.getApprovalKey();
    } catch (error) {
      this.fail(error, "KIS_REALTIME_APPROVAL_FAILED");
      return;
    }
    await new Promise((resolve) => {
      let settled = false;
      let socket;
      let openTimer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (openTimer) this.clearTimeoutImpl(openTimer);
        resolve();
      };
      try {
        socket = new this.WebSocketImpl(this.websocketUrl);
        this.socket = socket;
      } catch (error) {
        this.fail(error, "KIS_REALTIME_SOCKET_CREATE_FAILED");
        finish();
        return;
      }
      openTimer = this.setTimeoutImpl(() => {
        this.recordError(new Error("WebSocket 연결 시간이 초과되었습니다."), "KIS_REALTIME_CONNECT_TIMEOUT");
        try { socket.close(); } catch { /* no-op */ }
        this.setState("ERROR");
        this.scheduleReconnect();
        finish();
      }, this.timeoutMs);
      addSocketListener(socket, "open", () => {
        if (socket !== this.socket) return finish();
        this.reconnectAttempt = 0;
        this.lastConnectedAt = this.now();
        this.lastError = null;
        this.setState("CONNECTED");
        for (const item of this.desired.values()) this.sendVenueSubscriptions(item, "1", approvalKey);
        finish();
      });
      addSocketListener(socket, "message", (event) => {
        void this.handleMessage(event?.data ?? event).catch((error) => {
          this.recordError(error, "KIS_REALTIME_MESSAGE_FAILED");
        });
      });
      addSocketListener(socket, "error", () => {
        this.recordError(new Error("WebSocket 오류가 발생했습니다."), "KIS_REALTIME_SOCKET_ERROR");
      });
      addSocketListener(socket, "close", () => {
        if (socket !== this.socket) return;
        this.socket = null;
        this.activeSubscriptions.clear();
        this.lastDisconnectedAt = this.now();
        if (this.started) {
          this.setState("DISCONNECTED");
          this.scheduleReconnect();
        }
        finish();
      });
    });
  }

  async getApprovalKey() {
    if (this.approvalKey && this.approvalIssuedAt !== null
      && this.now() - this.approvalIssuedAt < APPROVAL_MAX_AGE_MS) return this.approvalKey;
    if (!this.approvalRequest) {
      this.approvalRequest = this.issueApprovalKey().finally(() => { this.approvalRequest = null; });
    }
    return this.approvalRequest;
  }

  async issueApprovalKey() {
    const controller = new AbortController();
    const timeout = this.setTimeoutImpl(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(new URL(APPROVAL_PATH, this.config.baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/plain", charset: "UTF-8" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          appkey: this.config.appKey,
          secretkey: this.config.appSecret,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new KisRealtimeError(
        error?.name === "AbortError"
          ? "한국투자 WebSocket 접속키 발급 시간이 초과되었습니다."
          : `한국투자 WebSocket 접속키 네트워크 요청에 실패했습니다: ${redact(errorMessage(error), this.config)}`,
        error?.name === "AbortError" ? "KIS_REALTIME_APPROVAL_TIMEOUT" : "KIS_REALTIME_APPROVAL_NETWORK_ERROR",
      );
    } finally {
      this.clearTimeoutImpl(timeout);
    }
    const payload = await parseJson(response, "WebSocket 접속키 발급");
    const approvalKey = text(payload?.approval_key);
    if (!response.ok || !approvalKey) {
      const detail = firstText(payload?.msg1, payload?.error_description, payload?.message);
      throw new KisRealtimeError(
        `한국투자 WebSocket 접속키 발급 실패${detail ? `: ${redact(detail, this.config)}` : ""}`,
        response.ok ? "KIS_REALTIME_APPROVAL_INVALID_RESPONSE" : "KIS_REALTIME_APPROVAL_HTTP_ERROR",
        response.ok ? 502 : response.status,
      );
    }
    this.approvalKey = approvalKey;
    this.approvalIssuedAt = this.now();
    return approvalKey;
  }

  sendVenueSubscriptions(item, trType, approvalKey = this.approvalKey) {
    const ids = KIS_REALTIME_TR[item.venue];
    if (!ids || !approvalKey || !isOpen(this.socket)) return;
    this.sendSubscription(ids.orderBook, item.symbol, trType, approvalKey);
    this.sendSubscription(ids.trade, item.symbol, trType, approvalKey);
  }

  sendSubscription(trId, symbol, trType, approvalKey) {
    try {
      this.socket.send(JSON.stringify({
        header: { approval_key: approvalKey, custtype: "P", tr_type: trType, "content-type": "utf-8" },
        body: { input: { tr_id: trId, tr_key: symbol } },
      }));
      const key = `${trId}:${symbol}`;
      if (trType === "1") this.activeSubscriptions.add(key);
      else this.activeSubscriptions.delete(key);
    } catch (error) {
      this.recordError(error, "KIS_REALTIME_SUBSCRIPTION_SEND_FAILED");
    }
  }

  async handleMessage(data) {
    const raw = await messageText(data);
    if (!raw) return;
    this.lastMessageAt = this.now();
    if (raw.startsWith("{")) return this.handleSystemMessage(raw);
    const parts = raw.split("|");
    const schema = TR_SCHEMAS.get(parts[1]);
    if (!schema || parts.length < 4) return;
    const count = Math.max(1, Number.parseInt(parts[2], 10) || 1);
    const values = parts.slice(3).join("|").split("^");
    for (let index = 0; index < count; index += 1) {
      const row = values.slice(index * schema.columns.length, (index + 1) * schema.columns.length);
      if (row.length < schema.columns.length) break;
      const record = Object.fromEntries(schema.columns.map((column, offset) => [column, row[offset]]));
      if (schema.type === "ORDER_BOOK") this.applyOrderBook(record, schema.venue, parts[1]);
      else this.applyTrade(record, schema.venue, parts[1]);
    }
  }

  handleSystemMessage(raw) {
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    if (text(payload?.header?.tr_id) === "PINGPONG") {
      if (isOpen(this.socket)) this.socket.send(raw);
      return;
    }
    const rtCode = text(payload?.body?.rt_cd);
    if (rtCode && rtCode !== "0") {
      this.recordError(
        new Error(redact(firstText(payload?.body?.msg1, payload?.body?.msg_cd, "WebSocket 구독 거절"), this.config)),
        "KIS_REALTIME_SUBSCRIPTION_REJECTED",
      );
    }
  }

  applyOrderBook(record, venue, trId) {
    const symbol = normalizeSymbol(record.symbol);
    const asks = levels(record, "askPrice", "askSize");
    const bids = levels(record, "bidPrice", "bidSize");
    const bestAsk = asks[0]?.price ?? null;
    const bestBid = bids[0]?.price ?? null;
    const totalAskSize = numberOrNull(record.totalAskSize) ?? sumSizes(asks);
    const totalBidSize = numberOrNull(record.totalBidSize) ?? sumSizes(bids);
    const midpoint = bestAsk !== null && bestBid !== null ? (bestAsk + bestBid) / 2 : null;
    const spread = bestAsk !== null && bestBid !== null ? Math.max(0, bestAsk - bestBid) : null;
    const totalBook = totalAskSize + totalBidSize;
    this.mergeMarketData(symbol, venue, {
      orderBook: {
        source: "KIS_WEBSOCKET", trId, venue, symbol,
        businessTime: text(record.businessTime),
        hourClassCode: text(record.hourClassCode),
        bestAsk, bestBid, spread,
        spreadBps: spread !== null && midpoint > 0 ? round((spread / midpoint) * 10_000, 3) : null,
        asks, bids, totalAskSize, totalBidSize,
        bidAskImbalance: totalBook > 0 ? round((totalBidSize - totalAskSize) / totalBook, 4) : 0,
        anticipatedPrice: numberOrNull(record.anticipatedPrice),
        anticipatedQuantity: numberOrNull(record.anticipatedQuantity),
        accumulatedVolume: numberOrNull(record.accumulatedVolume),
        dealClassCode: text(record.dealClassCode),
        krxMidPrice: numberOrNull(record.krxMidPrice),
        krxMidTotalSize: numberOrNull(record.krxMidTotalSize),
        nxtMidPrice: numberOrNull(record.nxtMidPrice),
        nxtMidTotalSize: numberOrNull(record.nxtMidTotalSize),
        receivedAt: this.now(),
      },
    });
  }

  applyTrade(record, venue, trId) {
    const symbol = normalizeSymbol(record.symbol);
    this.mergeMarketData(symbol, venue, {
      trade: {
        source: "KIS_WEBSOCKET", trId, venue, symbol,
        businessDate: text(record.businessDate),
        tradeTime: text(record.tradeTime),
        currentPrice: numberOrNull(record.currentPrice),
        previousChange: numberOrNull(record.previousChange),
        previousChangeSign: text(record.previousChangeSign),
        changePercent: numberOrNull(record.changePercent),
        weightedAveragePrice: numberOrNull(record.weightedAveragePrice),
        openPrice: numberOrNull(record.openPrice),
        highPrice: numberOrNull(record.highPrice),
        lowPrice: numberOrNull(record.lowPrice),
        bestAsk: numberOrNull(record.bestAsk),
        bestBid: numberOrNull(record.bestBid),
        tradeVolume: numberOrNull(record.tradeVolume),
        accumulatedVolume: numberOrNull(record.accumulatedVolume),
        accumulatedTradingValue: numberOrNull(record.accumulatedTradingValue),
        executionStrength: numberOrNull(record.executionStrength),
        buyRatio: numberOrNull(record.buyRatio),
        totalAskSize: numberOrNull(record.totalAskSize),
        totalBidSize: numberOrNull(record.totalBidSize),
        tradingHalted: String(record.tradingHalt ?? "").trim().toUpperCase() === "Y",
        hourClassCode: text(record.hourClassCode),
        marketTradingTimeClassCode: text(record.marketTradingTimeClassCode),
        viStandardPrice: numberOrNull(record.viStandardPrice),
        receivedAt: this.now(),
      },
    });
  }

  mergeMarketData(symbol, venue, patch) {
    const previous = this.marketData.get(symbol) ?? { symbol, venue, orderBook: null, trade: null };
    this.marketData.set(symbol, { ...previous, venue, ...patch });
    this.emit("marketData", this.snapshot(symbol));
  }

  findDesiredVenue(symbol) {
    for (const item of this.desired.values()) if (item.symbol === symbol) return item.venue;
    return null;
  }

  scheduleReconnect() {
    if (!this.started || this.desired.size === 0 || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * (2 ** Math.min(8, this.reconnectAttempt - 1)));
    this.reconnectTimer = this.setTimeoutImpl(() => {
      this.reconnectTimer = null;
      void this.ensureConnected();
    }, delay);
  }

  fail(error, code) {
    this.recordError(error, code);
    this.setState("ERROR");
    this.scheduleReconnect();
  }

  setState(state) {
    this.state = state;
    this.emit("status", this.status());
  }

  recordError(error, code) {
    this.lastError = { code: typeof error?.code === "string" ? error.code : code, message: redact(errorMessage(error), this.config), at: this.now() };
    this.emit("errorState", { ...this.lastError });
  }
}

function range(prefix) { return Array.from({ length: 10 }, (_, index) => `${prefix}${index + 1}`); }
function levels(record, pricePrefix, sizePrefix) {
  return Array.from({ length: 10 }, (_, index) => ({
    price: numberOrNull(record[`${pricePrefix}${index + 1}`]),
    size: numberOrNull(record[`${sizePrefix}${index + 1}`]),
  })).filter((level) => level.price !== null && level.size !== null);
}
function normalizeWatchItems(items, maxSymbols) {
  if (!Array.isArray(items)) throw new TypeError("실시간 구독 종목 목록은 배열이어야 합니다.");
  const result = new Map();
  for (const raw of items) {
    if (result.size >= maxSymbols) break;
    const item = typeof raw === "string" ? { symbol: raw, venue: "KRX" } : raw;
    const symbol = normalizeSymbol(item?.symbol);
    const venue = normalizeVenue(item?.venue);
    result.set(`${venue}:${symbol}`, { symbol, venue });
  }
  return result;
}
function normalizeSymbol(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  if (!/^(?:\d{6}|Q\d{6})$/.test(symbol)) {
    throw new KisRealtimeError("실시간 symbol은 6자리 종목코드 또는 Q로 시작하는 ETN 코드여야 합니다.", "KIS_REALTIME_INVALID_SYMBOL", 400);
  }
  return symbol;
}
function normalizeVenue(value) {
  const venue = String(value ?? "KRX").trim().toUpperCase();
  if (venue === "UN" || venue === "INTEGRATED") return "UNIFIED";
  if (!Object.hasOwn(KIS_REALTIME_TR, venue)) {
    throw new KisRealtimeError("실시간 venue는 KRX, NXT, UNIFIED 중 하나여야 합니다.", "KIS_REALTIME_INVALID_VENUE", 400);
  }
  return venue;
}
function addSocketListener(socket, event, listener) {
  if (typeof socket.addEventListener === "function") socket.addEventListener(event, listener);
  else if (typeof socket.on === "function") socket.on(event, listener);
  else socket[`on${event}`] = listener;
}
function isOpen(socket) { return Boolean(socket) && socket.readyState === 1; }
function isConnecting(socket) { return Boolean(socket) && socket.readyState === 0; }
async function messageText(value) {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf8");
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.text();
  return String(value ?? "");
}
async function parseJson(response, operation) {
  try { return await response.json(); }
  catch { throw new KisRealtimeError(`한국투자 ${operation} 응답이 JSON이 아닙니다.`, "KIS_REALTIME_INVALID_JSON_RESPONSE"); }
}
function normalizeWebSocketUrl(value) {
  const url = new URL(String(value));
  if (!["ws:", "wss:"].includes(url.protocol)) throw new TypeError("websocketUrl은 ws 또는 wss URL이어야 합니다.");
  return url.toString();
}
function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${field}는 양의 정수여야 합니다.`);
  return value;
}
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(number) ? number : null;
}
function text(value) {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result || null;
}
function firstText(...values) {
  for (const value of values) { const result = text(value); if (result) return result; }
  return null;
}
function sumSizes(items) { return items.reduce((sum, item) => sum + (item.size ?? 0), 0); }
function age(now, timestamp) { return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : null; }
function round(value, digits) { const power = 10 ** digits; return Math.round(value * power) / power; }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
function redact(value, config) {
  let result = String(value ?? "");
  for (const secret of [config?.appKey, config?.appSecret]) {
    if (typeof secret === "string" && secret) result = result.replaceAll(secret, "[REDACTED]");
  }
  return result;
}
