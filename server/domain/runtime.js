import { EventEmitter } from "node:events";
import { calculateMicrostructureMetrics } from "./analysis.js";
import { PaperTrader } from "./paperTrader.js";
import { PositionRiskTracker } from "./positionRiskTracker.js";
import { MarketSimulator } from "./simulator.js";
import { evaluateAutoStrategy } from "./strategyPolicy.js";
import {
  DEFAULT_STRATEGY_SETTINGS,
  normalizeStrategySettings,
} from "./strategySettings.js";

export class MarketRuntime extends EventEmitter {
  constructor(symbol, symbolName, initialPrice, {
    now = Date.now,
    strategySettings = DEFAULT_STRATEGY_SETTINGS,
    strategySettingsStore = null,
  } = {}) {
    super();
    this.symbol = symbol;
    this.symbolName = symbolName;
    this.previousClose = initialPrice;
    this.now = now;
    this.simulator = new MarketSimulator(initialPrice);
    this.trader = new PaperTrader(10_000_000, { now });
    this.positionRiskTracker = new PositionRiskTracker();
    this.strategySettingsStore = strategySettingsStore;
    this.strategySettings = normalizeStrategySettings(strategySettings, {
      maxOrderQuantity: this.trader.limits.maxOrderQuantity,
    });
    this.killSwitch = false;
    this.autoPaperTrading = false;
    this.lastAutoOrderAt = 0;
    this.timer = null;
    const initialTick = this.simulator.next(this.now());
    this.snapshotValue = this.makeSnapshot(initialTick, 0);
    this.syncPositionRisk(initialTick.lastPrice, initialTick.timestamp);
  }

  start() {
    if (!this.timer) this.timer = setInterval(() => this.advance(), 200);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot() { return structuredClone(this.snapshotValue); }

  getStrategySettings() {
    return structuredClone(this.strategySettings);
  }

  setStrategySettings(patch) {
    const normalized = normalizeStrategySettings(patch, {
      base: this.strategySettings,
      maxOrderQuantity: this.trader.limits.maxOrderQuantity,
    });
    this.strategySettings = this.strategySettingsStore
      ? this.strategySettingsStore.save(normalized)
      : normalized;
    this.snapshotValue.strategy.settings = this.getStrategySettings();
    this.emitSnapshot();
    return this.getStrategySettings();
  }

  resetStrategySettings() {
    this.strategySettings = this.strategySettingsStore
      ? this.strategySettingsStore.reset()
      : normalizeStrategySettings(DEFAULT_STRATEGY_SETTINGS, {
        maxOrderQuantity: this.trader.limits.maxOrderQuantity,
      });
    this.snapshotValue.strategy.settings = this.getStrategySettings();
    this.emitSnapshot();
    return this.getStrategySettings();
  }

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
    this.syncPositionRisk(this.snapshotValue.lastPrice, timestamp);
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
    this.positionRiskTracker.reset();
    this.snapshotValue.account = this.trader.snapshot(this.snapshotValue.lastPrice);
    this.snapshotValue.strategy.riskState = this.positionRiskTracker.snapshot();
    this.emitSnapshot();
  }

  advance(now = this.now()) {
    const startedAt = performance.now();
    const tick = this.simulator.next(now);
    this.snapshotValue = this.makeSnapshot(tick, Number((performance.now() - startedAt).toFixed(2)));
    this.trader.processOpenOrders({ book: tick.book, timestamp: tick.timestamp });
    this.snapshotValue.account = this.trader.snapshot(tick.lastPrice);
    this.syncPositionRisk(tick.lastPrice, tick.timestamp);
    this.maybeRunStrategy(tick.timestamp);
    this.snapshotValue.account = this.trader.snapshot(tick.lastPrice);
    this.syncPositionRisk(tick.lastPrice, tick.timestamp);
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
      strategy: {
        settings: this.getStrategySettings(),
        lastAutoOrderAt: this.lastAutoOrderAt,
        enabledOnRestart: false,
        riskState: this.positionRiskTracker.snapshot(),
      },
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

  syncPositionRisk(lastPrice, timestamp) {
    const state = this.positionRiskTracker.update({
      quantity: this.snapshotValue.account.position.quantity,
      lastPrice,
      timestamp,
    });
    if (this.snapshotValue.strategy) this.snapshotValue.strategy.riskState = state;
    return state;
  }

  maybeRunStrategy(now = this.now()) {
    if (!this.autoPaperTrading || this.killSwitch) return;
    const intent = evaluateAutoStrategy({
      metrics: this.snapshotValue.metrics,
      account: this.snapshotValue.account,
      settings: this.strategySettings,
      now,
      lastOrderAt: this.lastAutoOrderAt,
      lastPrice: this.snapshotValue.lastPrice,
      positionRiskState: this.snapshotValue.strategy.riskState,
    });
    if (!intent) return;

    const reason = intent.reason.toLowerCase().replaceAll("_", "-");
    const order = this.submitOrder({
      side: intent.side,
      type: "MARKET",
      quantity: intent.quantity,
      source: "STRATEGY",
      clientOrderId: `strategy-${reason}-${now}`,
      timestamp: now,
    }, undefined, "STRATEGY", false);
    if (order.status !== "REJECTED" && order.status !== "CANCELLED") {
      this.lastAutoOrderAt = now;
      this.snapshotValue.strategy.lastAutoOrderAt = now;
    }
  }

  emitSnapshot() { this.emit("snapshot", this.snapshot()); }
}
