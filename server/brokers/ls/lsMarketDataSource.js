import { EventEmitter } from "node:events";
import { getRealtimeTrCodes } from "./lsProtocol.js";

export class LsMarketDataSource extends EventEmitter {
  constructor({ symbol, market = "KOSPI", environment = "paper", restClient, realtimeClient, now = Date.now }) {
    super();
    if (!symbol || !restClient || !realtimeClient) {
      throw new Error("LsMarketDataSource에는 symbol, restClient, realtimeClient가 필요합니다.");
    }
    this.symbol = String(symbol);
    this.market = String(market).toUpperCase();
    this.environment = String(environment).toLowerCase();
    this.restClient = restClient;
    this.realtimeClient = realtimeClient;
    this.now = now;
    this.mode = this.environment === "live" ? "LS_LIVE_DATA" : "LS_PAPER_DATA";
    this.provider = "LS_SECURITIES";
    this.connected = false;
    this.tickSize = 100;
    this.lastPrice = 0;
    this.previousClose = 0;
    this.book = { asks: [], bids: [] };
    this.trades = [];
    this.candles = [];
    this.activeCandle = null;
    this.tradeSequence = 0;
    this.started = false;
    this.bindRealtimeEvents();
  }

  bindRealtimeEvents() {
    this.realtimeClient.on("status", (status) => {
      this.connected = Boolean(status.connected);
      this.emit("status", { ...status, provider: this.provider, mode: this.mode });
    });
    this.realtimeClient.on("book", (book) => {
      if (book.symbol && book.symbol !== this.symbol) return;
      this.book = { asks: book.asks, bids: book.bids };
      this.tickSize = inferTickSize(this.book, this.tickSize);
      this.emitTick(this.now());
    });
    this.realtimeClient.on("trade", (trade) => {
      if (trade.symbol && trade.symbol !== this.symbol) return;
      if (trade.price <= 0 || trade.size <= 0 || trade.side === "UNKNOWN") return;
      const normalized = {
        id: `ls-${this.symbol}-${trade.timestamp}-${this.tradeSequence++}`,
        timestamp: trade.timestamp,
        price: trade.price,
        size: trade.size,
        side: trade.side,
      };
      this.lastPrice = trade.price;
      this.trades.push(normalized);
      this.trades = this.trades.slice(-240);
      this.updateCandle(normalized);
      this.emitTick(trade.timestamp);
    });
    this.realtimeClient.on("error", (error) => this.emit("error", error));
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.emit("status", { connected: false, state: "connecting", provider: this.provider, mode: this.mode });
    try {
      const initial = await this.restClient.getCurrentOrderBook(this.symbol);
      this.lastPrice = initial.lastPrice;
      this.previousClose = initial.previousClose;
      this.book = initial.book;
      this.tickSize = inferTickSize(this.book, this.tickSize);
      this.emitTick(initial.timestamp);
      await this.realtimeClient.connect();
      const trCodes = getRealtimeTrCodes(this.market);
      this.realtimeClient.subscribe({ trCode: trCodes.book, symbol: this.symbol });
      this.realtimeClient.subscribe({ trCode: trCodes.trade, symbol: this.symbol });
    } catch (error) {
      this.started = false;
      this.emit("error", error);
      throw error;
    }
  }

  stop() {
    this.realtimeClient.close();
    this.started = false;
    this.connected = false;
  }

  emitTick(timestamp) {
    this.emit("tick", {
      timestamp,
      lastPrice: this.lastPrice,
      previousClose: this.previousClose,
      book: structuredClone(this.book),
      trades: structuredClone(this.trades),
      candles: structuredClone([...this.candles, ...(this.activeCandle ? [this.activeCandle] : [])].slice(-180)),
    });
  }

  updateCandle(trade) {
    const bucket = Math.floor(trade.timestamp / 1_000) * 1_000;
    if (!this.activeCandle || this.activeCandle.time !== bucket) {
      if (this.activeCandle) this.candles.push(this.activeCandle);
      this.candles = this.candles.slice(-179);
      this.activeCandle = {
        time: bucket,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: trade.size,
      };
      return;
    }
    this.activeCandle.high = Math.max(this.activeCandle.high, trade.price);
    this.activeCandle.low = Math.min(this.activeCandle.low, trade.price);
    this.activeCandle.close = trade.price;
    this.activeCandle.volume += trade.size;
  }
}

function inferTickSize(book, fallback) {
  const prices = [...book.asks, ...book.bids]
    .map((level) => level.price)
    .filter((price) => Number.isFinite(price) && price > 0)
    .sort((a, b) => a - b);
  let minimum = Infinity;
  for (let index = 1; index < prices.length; index += 1) {
    const difference = prices[index] - prices[index - 1];
    if (difference > 0) minimum = Math.min(minimum, difference);
  }
  return Number.isFinite(minimum) ? minimum : fallback;
}
