import { EventEmitter } from "node:events";
import { calculateMicrostructureMetrics } from "./analysis.js";
import { PaperTrader } from "./paperTrader.js";
import { SimulationMarketDataSource } from "../market/simulationMarketDataSource.js";

export class MarketRuntime extends EventEmitter {
  constructor(symbol, symbolName, initialPrice, { marketSource, now = Date.now, maxMarketDataAgeMs = 5_000 } = {}) {
    super();
    this.symbol = symbol;
    this.symbolName = symbolName;
    this.previousClose = initialPrice;
    this.marketSource = marketSource ?? new SimulationMarketDataSource(initialPrice);
    this.now = now;
    this.maxMarketDataAgeMs = maxMarketDataAgeMs;
    this.trader = new PaperTrader();
    this.killSwitch = false;
    this.autoPaperTrading = false;
    this.lastAutoOrderAt = 0;
    this.feedError = null;
    this.started = false;
    this.snapshotValue = this.makeSnapshot(createEmptyTick(initialPrice), 0);
    this.bindMarketSource();
  }

  bindMarketSource() {
    this.marketSource.on("tick", (tick) => this.handleTick(tick));
    this.marketSource.on("status", (status) => {
      this.snapshotValue.system.feedConnected = Boolean(status.connected);
      this.snapshotValue.system.connectionState = status.state ?? (status.connected ? "connected" : "disconnected");
      this.snapshotValue.system.mode = status.mode ?? this.marketSource.mode ?? this.snapshotValue.system.mode;
      this.snapshotValue.system.provider = status.provider ?? this.marketSource.provider ?? this.snapshotValue.system.provider;
      this.emitSnapshot();
    });
    this.marketSource.on("error", (error) => this.setFeedError(error));
  }

  async start() {
    if (this.started) return;
    this.started = true;
    try {
      await this.marketSource.start();
    } catch (error) {
      this.started = false;
      this.setFeedError(error);
      throw error;
    }
  }

  stop() {
    this.marketSource.stop();
    this.started = false;
  }

  snapshot() { return structuredClone(this.snapshotValue); }

  setFeedError(error) {
    this.feedError = error instanceof Error ? error.message : String(error);
    this.snapshotValue.system.feedConnected = false;
    this.snapshotValue.system.connectionState = "error";
    this.snapshotValue.system.lastError = this.feedError;
    this.emitSnapshot();
  }

  submitOrder(side, quantity, source = "MANUAL", emit = true) {
    const marketDataIssue = this.getMarketDataIssue();
    const order = this.trader.submit({
      side,
      quantity,
      referencePrice: this.snapshotValue.lastPrice,
      spread: this.snapshotValue.metrics.spread,
      tickSize: this.marketSource.tickSize ?? 1,
      source,
      killSwitch: this.killSwitch,
      marketDataAvailable: marketDataIssue === null,
      marketDataReason: marketDataIssue,
    });
    this.snapshotValue.account = this.trader.snapshot(this.snapshotValue.lastPrice);
    if (emit) this.emitSnapshot();
    return order;
  }

  setKillSwitch(enabled) {
    this.killSwitch = enabled;
    if (enabled) this.autoPaperTrading = false;
    this.snapshotValue.system.killSwitch = enabled;
    this.snapshotValue.system.autoPaperTrading = this.autoPaperTrading;
    this.emitSnapshot();
  }

  setAutoPaperTrading(enabled) {
    this.autoPaperTrading = Boolean(enabled) && !this.killSwitch && this.getMarketDataIssue() === null;
    this.snapshotValue.system.autoPaperTrading = this.autoPaperTrading;
    this.emitSnapshot();
  }

  resetPaperAccount() {
    this.trader.reset();
    this.snapshotValue.account = this.trader.snapshot(this.snapshotValue.lastPrice);
    this.emitSnapshot();
  }

  handleTick(tick) {
    const startedAt = performance.now();
    if (Number.isFinite(tick.previousClose) && tick.previousClose > 0) this.previousClose = tick.previousClose;
    this.feedError = null;
    this.snapshotValue = this.makeSnapshot(tick, Number((performance.now() - startedAt).toFixed(2)));
    this.maybeRunStrategy();
    this.snapshotValue.account = this.trader.snapshot(tick.lastPrice);
    this.emitSnapshot();
  }

  makeSnapshot(tick, latencyMs) {
    const tickSize = this.marketSource.tickSize ?? 1;
    const metrics = calculateMicrostructureMetrics({
      book: tick.book,
      trades: tick.trades,
      tickSize,
      now: tick.timestamp,
    });
    return {
      symbol: this.symbol,
      symbolName: this.symbolName,
      timestamp: tick.timestamp,
      lastPrice: tick.lastPrice,
      previousClose: this.previousClose,
      changePercent: ((tick.lastPrice - this.previousClose) / this.previousClose) * 100,
      book: tick.book,
      trades: tick.trades.slice(-30).reverse(),
      candles: tick.candles,
      metrics,
      account: this.trader.snapshot(tick.lastPrice),
      riskLimits: this.trader.limits,
      system: {
        mode: this.marketSource.mode ?? "SIMULATION",
        provider: this.marketSource.provider ?? "UNKNOWN",
        feedConnected: Boolean(this.marketSource.connected),
        connectionState: this.marketSource.connected ? "connected" : "starting",
        killSwitch: this.killSwitch,
        autoPaperTrading: this.autoPaperTrading,
        latencyMs,
        lastEventAt: tick.timestamp,
        lastError: this.feedError,
      },
    };
  }

  getMarketDataIssue() {
    if (!this.snapshotValue.system.feedConnected) return "시세 연결 끊김";
    const lastEventAt = Number(this.snapshotValue.system.lastEventAt);
    if (!Number.isFinite(lastEventAt) || this.now() - lastEventAt > this.maxMarketDataAgeMs) {
      return "시세 데이터 지연";
    }
    return null;
  }

  maybeRunStrategy() {
    if (!this.autoPaperTrading || this.killSwitch || this.getMarketDataIssue() !== null) return;
    const now = Date.now();
    if (now - this.lastAutoOrderAt < 5_000) return;
    const { signal, confidence, spreadTicks } = this.snapshotValue.metrics;
    const quantity = this.snapshotValue.account.position.quantity;
    if (signal === "BUY" && confidence >= 50 && spreadTicks <= 2 && quantity === 0) {
      this.submitOrder("BUY", 10, "STRATEGY", false);
      this.lastAutoOrderAt = now;
    } else if (signal === "SELL" && confidence >= 50 && quantity > 0) {
      this.submitOrder("SELL", quantity, "STRATEGY", false);
      this.lastAutoOrderAt = now;
    }
  }

  emitSnapshot() { this.emit("snapshot", this.snapshot()); }
}

function createEmptyTick(initialPrice) {
  return {
    timestamp: Date.now(),
    lastPrice: initialPrice,
    book: { bids: [], asks: [] },
    trades: [],
    candles: [],
  };
}
