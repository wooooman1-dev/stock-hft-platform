import { EventEmitter } from "node:events";
import { calculateMicrostructureMetrics } from "./analysis.js";
import { PaperTrader } from "./paperTrader.js";
import { MarketSimulator } from "./simulator.js";

export class MarketRuntime extends EventEmitter {
  constructor(symbol, symbolName, initialPrice, { now = Date.now } = {}) {
    super();
    this.symbol = symbol;
    this.symbolName = symbolName;
    this.previousClose = initialPrice;
    this.now = now;
    this.simulator = new MarketSimulator(initialPrice);
    this.trader = new PaperTrader(10_000_000, { now });
    this.killSwitch = false;
    this.autoPaperTrading = false;
    this.lastAutoOrderAt = 0;
    this.timer = null;
    this.snapshotValue = this.makeSnapshot(this.simulator.next(), 0);
  }

  start() {
    if (!this.timer) this.timer = setInterval(() => this.advance(), 200);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot() { return structuredClone(this.snapshotValue); }

  submitOrder(sideOrInput, quantity, source = "MANUAL", emit = true) {
    const request = typeof sideOrInput === "object" && sideOrInput !== null
      ? { ...sideOrInput }
      : { side: sideOrInput, quantity, source };
    const timestamp = Number.isFinite(Number(request.timestamp)) ? Number(request.timestamp) : this.now();
    const order = this.trader.submit({
      ...request,
      type: request.type ?? "MARKET",
      source: request.source ?? source,
      referencePrice: this.snapshotValue.lastPrice,
      book: this.snapshotValue.book,
      tickSize: this.simulator.tickSize,
      timestamp,
      killSwitch: this.killSwitch,
    });
    this.snapshotValue.account = this.trader.snapshot(this.snapshotValue.lastPrice);
    if (emit) this.emitSnapshot();
    return order;
  }

  cancelOrder(orderId, emit = true) {
    const order = this.trader.cancel(orderId, { timestamp: this.now() });
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
    this.autoPaperTrading = Boolean(enabled) && !this.killSwitch;
    this.snapshotValue.system.autoPaperTrading = this.autoPaperTrading;
    this.emitSnapshot();
  }

  resetPaperAccount() {
    this.trader.reset();
    this.snapshotValue.account = this.trader.snapshot(this.snapshotValue.lastPrice);
    this.emitSnapshot();
  }

  advance(now = this.now()) {
    const startedAt = performance.now();
    const tick = this.simulator.next(now);
    this.snapshotValue = this.makeSnapshot(tick, Number((performance.now() - startedAt).toFixed(2)));
    this.trader.processOpenOrders({ book: tick.book, timestamp: tick.timestamp });
    this.snapshotValue.account = this.trader.snapshot(tick.lastPrice);
    this.maybeRunStrategy(tick.timestamp);
    this.snapshotValue.account = this.trader.snapshot(tick.lastPrice);
    this.emitSnapshot();
  }

  makeSnapshot(tick, latencyMs) {
    const metrics = calculateMicrostructureMetrics({
      book: tick.book,
      trades: tick.trades,
      tickSize: this.simulator.tickSize,
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
      tickSize: this.simulator.tickSize,
      system: {
        mode: "SIMULATION",
        feedConnected: true,
        killSwitch: this.killSwitch,
        autoPaperTrading: this.autoPaperTrading,
        latencyMs,
        lastEventAt: tick.timestamp,
        executionModel: "VISIBLE_DEPTH_MARKET_IOC_LIMIT_GTC",
      },
    };
  }

  maybeRunStrategy(now = this.now()) {
    if (!this.autoPaperTrading || this.killSwitch) return;
    if (now - this.lastAutoOrderAt < 5_000) return;
    const { signal, confidence, spreadTicks } = this.snapshotValue.metrics;
    const quantity = this.snapshotValue.account.position.quantity;
    if (signal === "BUY" && confidence >= 50 && spreadTicks <= 2 && quantity === 0) {
      const order = this.submitOrder({
        side: "BUY",
        type: "MARKET",
        quantity: 10,
        source: "STRATEGY",
        clientOrderId: `strategy-buy-${now}`,
        timestamp: now,
      }, undefined, "STRATEGY", false);
      if (order.status !== "REJECTED" && order.status !== "CANCELLED") this.lastAutoOrderAt = now;
    } else if (signal === "SELL" && confidence >= 50 && quantity > 0) {
      const order = this.submitOrder({
        side: "SELL",
        type: "MARKET",
        quantity,
        source: "STRATEGY",
        clientOrderId: `strategy-sell-${now}`,
        timestamp: now,
      }, undefined, "STRATEGY", false);
      if (order.status !== "REJECTED" && order.status !== "CANCELLED") this.lastAutoOrderAt = now;
    }
  }

  emitSnapshot() { this.emit("snapshot", this.snapshot()); }
}
