import { EventEmitter } from "node:events";
import { getRealtimeTrCodes } from "./lsProtocol.js";

// 메인 화면(KisMainWorkspace)이 기대하는 실시간 시세 클라이언트 인터페이스
// (watchSymbols/status/stop + marketData·status·errorState 이벤트)를 LS증권 Open API로 구현한다.
// 주문은 연결하지 않는다. 시세만 바꾸고 계좌·주문은 기존 한국투자 모의투자 경로를 그대로 쓴다.
export class LsMainRealtimeClient extends EventEmitter {
  constructor({
    restClient,
    realtimeClient,
    environment = "paper",
    defaultMarket = "KOSPI",
    now = Date.now,
    staleAfterMs = 5_000,
    reconnectBaseMs = 2_000,
    reconnectMaxMs = 30_000,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  }) {
    super();
    if (!restClient || !realtimeClient) {
      throw new Error("LsMainRealtimeClient에는 restClient와 realtimeClient가 필요합니다.");
    }
    this.restClient = restClient;
    this.realtimeClient = realtimeClient;
    this.environment = String(environment).toLowerCase() === "live" ? "live" : "paper";
    this.defaultMarket = normalizeLsMarket(defaultMarket, "KOSPI");
    this.now = now;
    this.staleAfterMs = staleAfterMs;
    this.reconnectBaseMs = reconnectBaseMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.mode = this.environment === "live" ? "LS_LIVE_DATA" : "LS_PAPER_DATA";
    this.started = false;
    this.state = "IDLE";
    this.watched = null;
    this.subscribedCodes = null;
    this.data = emptyData();
    this.lastMessageAt = null;
    this.lastConnectedAt = null;
    this.lastDisconnectedAt = null;
    this.lastError = null;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.connectPromise = null;
    this.bindRealtime();
  }

  status() {
    const latestAt = this.latestAt();
    return {
      enabled: true,
      provider: "LS_SECURITIES",
      mode: this.mode,
      state: this.state,
      connected: this.state === "CONNECTED" && Boolean(this.realtimeClient.connected),
      watchedSymbol: this.watched?.symbol ?? null,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      lastMessageAt: this.lastMessageAt,
      freshestDataAgeMs: latestAt ? Math.max(0, this.now() - latestAt) : null,
      reconnectAttempt: this.reconnectAttempt,
      lastError: this.lastError ? { ...this.lastError } : null,
      automaticOrderConnected: false,
    };
  }

  watchSymbols(items) {
    if (!Array.isArray(items)) throw new TypeError("실시간 구독 종목 목록은 배열이어야 합니다.");
    const first = items[0];
    const symbol = String((typeof first === "string" ? first : first?.symbol) ?? "").trim().toUpperCase();
    if (!/^\d{6}$/.test(symbol)) {
      this.unsubscribeCurrent();
      this.watched = null;
      this.data = emptyData();
      this.setError("LS_UNSUPPORTED_SYMBOL", "LS증권 시세는 6자리 숫자 종목코드만 지원합니다.");
      return this.status();
    }
    const market = normalizeLsMarket(first?.market, this.defaultMarket);
    if (this.watched?.symbol === symbol && this.watched.market === market) {
      if (!this.started) this.start();
      return this.status();
    }
    this.unsubscribeCurrent();
    this.watched = { symbol, market };
    this.data = emptyData();
    this.lastError = null;
    const codes = getRealtimeTrCodes(market);
    this.realtimeClient.subscribe({ trCode: codes.book, symbol });
    this.realtimeClient.subscribe({ trCode: codes.trade, symbol });
    this.subscribedCodes = { ...codes, symbol };
    void this.loadInitialBook(symbol);
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
    this.realtimeClient.close();
    this.state = "STOPPED";
    this.emit("status", this.status());
  }

  snapshot(symbol = this.watched?.symbol) {
    const latestAt = this.latestAt();
    return structuredClone({
      symbol: symbol ?? null,
      provider: "LS_SECURITIES",
      connectionState: this.state,
      connected: this.state === "CONNECTED" && Boolean(this.realtimeClient.connected),
      orderBook: this.data.orderBook,
      trade: this.data.trade,
      previousClose: this.data.previousClose,
      latestAt,
      stale: latestAt === null || this.now() - latestAt > this.staleAfterMs,
      staleAfterMs: this.staleAfterMs,
      automaticOrderConnected: false,
    });
  }

  async ensureConnected() {
    if (!this.started || !this.watched || this.realtimeClient.connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.state = "CONNECTING";
    this.emit("status", this.status());
    this.connectPromise = this.realtimeClient.connect()
      .catch((error) => {
        this.setError("LS_REALTIME_CONNECT_FAILED", messageOf(error, "LS 실시간 연결에 실패했습니다."));
        this.state = "DISCONNECTED";
        this.scheduleReconnect();
      })
      .finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  scheduleReconnect() {
    if (!this.started || this.reconnectTimer) return;
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.setTimeoutImpl(() => {
      this.reconnectTimer = null;
      void this.ensureConnected();
    }, delay);
    this.reconnectTimer?.unref?.();
  }

  async loadInitialBook(symbol) {
    try {
      const initial = await this.restClient.getCurrentOrderBook(symbol);
      if (this.watched?.symbol !== symbol) return;
      const receivedAt = Number(initial.timestamp) || this.now();
      if (Number(initial.previousClose) > 0) this.data.previousClose = Number(initial.previousClose);
      if (!this.data.orderBook) this.data.orderBook = toOrderBook(initial.book, receivedAt);
      if (!this.data.trade && Number(initial.lastPrice) > 0) {
        this.data.trade = {
          currentPrice: Number(initial.lastPrice),
          tradeVolume: 0,
          receivedAt,
          tradeTime: null,
          businessDate: koreaDate(receivedAt),
          changePercent: changePercent(Number(initial.lastPrice), this.data.previousClose),
        };
      }
      this.emit("marketData", this.snapshot(symbol));
    } catch (error) {
      this.setError("LS_REST_ORDER_BOOK_FAILED", messageOf(error, "LS 현재가·호가 조회에 실패했습니다."));
    }
  }

  bindRealtime() {
    this.realtimeClient.on("status", (status) => {
      if (status?.connected) {
        this.state = "CONNECTED";
        this.lastConnectedAt = this.now();
        this.reconnectAttempt = 0;
        this.lastError = null;
      } else {
        this.state = this.started ? "DISCONNECTED" : "STOPPED";
        this.lastDisconnectedAt = this.now();
        this.scheduleReconnect();
      }
      this.emit("status", this.status());
    });
    this.realtimeClient.on("book", (book) => {
      if (!this.watched || (book.symbol && book.symbol !== this.watched.symbol)) return;
      const receivedAt = this.now();
      this.lastMessageAt = receivedAt;
      this.data.orderBook = toOrderBook(book, receivedAt);
      this.emit("marketData", this.snapshot());
    });
    this.realtimeClient.on("trade", (trade) => {
      if (!this.watched || (trade.symbol && trade.symbol !== this.watched.symbol)) return;
      if (!(trade.price > 0) || !(trade.size > 0)) return;
      const receivedAt = Number(trade.timestamp) || this.now();
      this.lastMessageAt = receivedAt;
      this.data.trade = {
        currentPrice: trade.price,
        tradeVolume: trade.size,
        receivedAt,
        tradeTime: trade.exchangeTime || null,
        businessDate: koreaDate(receivedAt),
        side: trade.side,
        changePercent: changePercent(trade.price, this.data.previousClose),
      };
      this.emit("marketData", this.snapshot());
    });
    this.realtimeClient.on("error", (error) => {
      this.setError("LS_REALTIME_ERROR", messageOf(error, "LS 실시간 시세 오류"));
    });
  }

  unsubscribeCurrent() {
    if (!this.subscribedCodes) return;
    const { book, trade, symbol } = this.subscribedCodes;
    this.realtimeClient.unsubscribe({ trCode: book, symbol });
    this.realtimeClient.unsubscribe({ trCode: trade, symbol });
    this.subscribedCodes = null;
  }

  latestAt() {
    return Math.max(this.data.orderBook?.receivedAt ?? 0, this.data.trade?.receivedAt ?? 0) || null;
  }

  setError(code, message) {
    this.lastError = { code, message, at: this.now() };
    this.emit("errorState", { ...this.lastError });
  }
}

export function normalizeLsMarket(value, fallback = "KOSPI") {
  const market = String(value ?? "").trim().toUpperCase();
  if (market === "KOSPI" || market === "KOSDAQ" || market === "UNIFIED") return market;
  if (market === "UN" || market === "INTEGRATED") return "UNIFIED";
  return fallback;
}

function toOrderBook(book, receivedAt) {
  const asks = Array.isArray(book?.asks) ? book.asks.map(({ price, size }) => ({ price, size })) : [];
  const bids = Array.isArray(book?.bids) ? book.bids.map(({ price, size }) => ({ price, size })) : [];
  return {
    asks,
    bids,
    bestAsk: asks[0]?.price ?? null,
    bestBid: bids[0]?.price ?? null,
    receivedAt,
  };
}

function emptyData() {
  return { orderBook: null, trade: null, previousClose: null };
}

function changePercent(price, previousClose) {
  if (!(price > 0) || !(previousClose > 0)) return null;
  return ((price - previousClose) / previousClose) * 100;
}

function koreaDate(timestamp) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}${value.month}${value.day}`;
}

function messageOf(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}
