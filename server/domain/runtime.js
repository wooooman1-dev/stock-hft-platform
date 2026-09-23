import { EventEmitter } from "node:events";
import { calculateMicrostructureMetrics } from "./analysis.js";
import { ExecutionJournalRecorder } from "./executionJournal.js";
import { PaperTrader } from "./paperTrader.js";
import { PositionRiskTracker } from "./positionRiskTracker.js";
import { MarketSimulator } from "./simulator.js";
import { evaluateAutoStrategy } from "./strategyPolicy.js";
import {
  DEFAULT_STRATEGY_SETTINGS,
  normalizeStrategySettings,
  StrategySettingsError,
} from "./strategySettings.js";

export class InstrumentSwitchError extends Error {
  constructor(message, code, statusCode = 409) {
    super(message);
    this.name = "InstrumentSwitchError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class StrategyApprovalError extends Error {
  constructor(message, code, statusCode = 404) {
    super(message);
    this.name = "StrategyApprovalError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class MarketRuntime extends EventEmitter {
  constructor(symbol, symbolName, initialPrice, {
    now = Date.now,
    strategySettings = DEFAULT_STRATEGY_SETTINGS,
    strategySettingsStore = null,
    executionJournal = null,
    previousClose = initialPrice,
    instrumentMarket = null,
    instrumentSecurityType = null,
    instrumentTickSize = 100,
    instrumentPriceSource = "ENV_DEFAULT",
    instrumentQuoteFetchedAt = null,
    instrumentSelectedAt = null,
    costModel = {},
  } = {}) {
    super();
    this.symbol = symbol;
    this.symbolName = symbolName;
    this.previousClose = positiveNumber(previousClose, "previousClose");
    this.instrumentMarket = optionalText(instrumentMarket);
    this.instrumentSecurityType = optionalText(instrumentSecurityType);
    this.instrumentPriceSource = String(instrumentPriceSource ?? "ENV_DEFAULT");
    this.instrumentQuoteFetchedAt = nullableTimestamp(instrumentQuoteFetchedAt);
    this.instrumentSelectedAt = nullableTimestamp(instrumentSelectedAt);
    this.now = now;
    this.simulator = new MarketSimulator(initialPrice, { tickSize: instrumentTickSize });
    this.trader = new PaperTrader(10_000_000, { now, costModel });
    this.executionJournalRecorder = new ExecutionJournalRecorder(executionJournal);
    this.positionRiskTracker = new PositionRiskTracker();
    this.strategySettingsStore = strategySettingsStore;
    this.strategySettings = normalizeStrategySettings(strategySettings, {
      maxOrderQuantity: this.trader.limits.maxOrderQuantity,
    });
    this.killSwitch = false;
    this.autoPaperTrading = false;
    this.lastAutoOrderAt = 0;
    this.pendingApprovals = new Map();
    this.approvalSequence = 0;
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

  getStrategySettingsHistory() {
    if (!this.strategySettingsStore) return [];
    return this.strategySettingsStore.history();
  }

  restoreStrategySettings(version) {
    if (!this.strategySettingsStore) {
      throw new StrategySettingsError(
        "전략 설정 저장소가 구성되지 않아 이전 버전을 복원할 수 없습니다.",
        "STRATEGY_SETTINGS_STORE_UNAVAILABLE",
      );
    }
    this.strategySettings = this.strategySettingsStore.restore(version);
    this.snapshotValue.strategy.settings = this.getStrategySettings();
    this.emitSnapshot();
    return this.getStrategySettings();
  }

  switchInstrument(input, { persist = null } = {}) {
    const selection = normalizeRuntimeInstrument(input, this.now());
    const sameSymbol = selection.symbol === this.symbol;
    const account = this.trader.snapshot(this.snapshotValue.lastPrice);
    if (this.autoPaperTrading) {
      throw new InstrumentSwitchError(
        "모의 자동전략을 끈 뒤 종목을 변경하세요.",
        "INSTRUMENT_SWITCH_AUTO_ACTIVE",
      );
    }
    if (account.position.quantity !== 0) {
      throw new InstrumentSwitchError(
        "내부 모의계좌의 보유수량을 먼저 0주로 만든 뒤 종목을 변경하세요.",
        "INSTRUMENT_SWITCH_POSITION_OPEN",
      );
    }
    if (account.openOrderCount !== 0) {
      throw new InstrumentSwitchError(
        "내부 모의계좌의 대기 주문을 모두 취소한 뒤 종목을 변경하세요.",
        "INSTRUMENT_SWITCH_ORDER_OPEN",
      );
    }
    if (account.orders.length !== 0) {
      throw new InstrumentSwitchError(
        sameSymbol
          ? "최신 KIS 가격으로 다시 초기화하려면 내부 모의계좌를 먼저 초기화하세요."
          : "다른 종목의 주문 내역이 섞이지 않도록 내부 모의계좌를 초기화한 뒤 종목을 변경하세요.",
        "INSTRUMENT_SWITCH_ACCOUNT_NOT_RESET",
      );
    }
    if (persist !== null && typeof persist !== "function") {
      throw new TypeError("persist는 함수여야 합니다.");
    }
    if (persist) persist(selection);

    this.symbol = selection.symbol;
    this.symbolName = selection.symbolName;
    this.previousClose = selection.previousClose;
    this.instrumentMarket = selection.market;
    this.instrumentSecurityType = selection.securityType;
    this.instrumentPriceSource = selection.priceSource;
    this.instrumentQuoteFetchedAt = selection.quoteFetchedAt;
    this.instrumentSelectedAt = selection.selectedAt;
    this.simulator = new MarketSimulator(selection.initialPrice, { tickSize: selection.tickSize });
    this.positionRiskTracker.reset();
    this.lastAutoOrderAt = 0;
    const tick = this.simulator.next(this.now());
    this.snapshotValue = this.makeSnapshot(tick, 0);
    this.snapshotValue.account = this.trader.snapshot(tick.lastPrice);
    this.syncPositionRisk(tick.lastPrice, tick.timestamp);
    this.emitSnapshot();
    return {
      changed: !sameSymbol,
      refreshed: sameSymbol,
      snapshot: this.snapshot(),
    };
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
    this.captureExecutionJournal();
    this.snapshotValue.account = this.trader.snapshot(this.snapshotValue.lastPrice);
    this.syncPositionRisk(this.snapshotValue.lastPrice, timestamp);
    if (emit) this.emitSnapshot();
    return order;
  }

  cancelOrder(orderId, emit = true) {
    const order = this.trader.cancel(orderId, { timestamp: this.now() });
    this.captureExecutionJournal();
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
    try {
      this.executionJournalRecorder.recordAccountReset(this.trader.account, this.now());
    } catch (error) {
      this.haltForExecutionJournalError();
      throw error;
    }
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
    this.captureExecutionJournal();
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
      instrument: {
        market: this.instrumentMarket,
        securityType: this.instrumentSecurityType,
        priceSource: this.instrumentPriceSource,
        quoteFetchedAt: this.instrumentQuoteFetchedAt,
        selectedAt: this.instrumentSelectedAt,
        simulation: true,
      },
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
        pendingApprovals: this.getPendingApprovals(),
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

  cancelOpenOrdersForStrategyExit(timestamp, reason) {
    const openOrderIds = this.trader.account.orders
      .filter((order) => order.isOpen)
      .map((order) => order.id);
    for (const orderId of openOrderIds) {
      this.trader.cancel(orderId, {
        reason: `전략 청산(${reason}) 전 대기 주문 취소`,
        timestamp,
      });
    }
    this.captureExecutionJournal();
    this.snapshotValue.account = this.trader.snapshot(this.snapshotValue.lastPrice);
    return openOrderIds.length;
  }

  maybeRunStrategy(now = this.now()) {
    if (!this.autoPaperTrading || this.killSwitch) return;
    this.expirePendingApprovals(now);
    let intent = evaluateAutoStrategy({
      metrics: this.snapshotValue.metrics,
      account: this.snapshotValue.account,
      settings: this.strategySettings,
      now,
      lastOrderAt: this.lastAutoOrderAt,
      lastPrice: this.snapshotValue.lastPrice,
      positionRiskState: this.snapshotValue.strategy.riskState,
    });
    if (!intent) return;

    if (intent.side === "SELL") {
      // 보호 청산(손절·트레일링·익절·최대보유시간)과 일반 매도신호는 반자동 승인 모드에서도
      // 항상 즉시 실행한다. 승인 대기는 새 위험(진입)에만 적용하고 위험 축소를 지연시키지 않는다.
      this.cancelOpenOrdersForStrategyExit(now, intent.reason);
      const positionQuantity = this.snapshotValue.account.position.quantity;
      if (!Number.isInteger(positionQuantity) || positionQuantity <= 0) return;
      intent = { ...intent, quantity: positionQuantity };
    } else if (this.strategySettings.approvalMode === "SEMI_AUTO") {
      this.requestApproval(intent, now);
      return;
    }

    this.executeStrategyIntent(intent, now);
  }

  executeStrategyIntent(intent, now) {
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
    return order;
  }

  requestApproval(intent, now) {
    const hasPending = [...this.pendingApprovals.values()].some((item) => item.status === "PENDING");
    if (hasPending) return;
    this.approvalSequence += 1;
    const id = `approval-${now}-${this.approvalSequence}`;
    const request = {
      id,
      side: intent.side,
      quantity: intent.quantity,
      reason: intent.reason,
      requestedAt: now,
      expiresAt: now + this.strategySettings.approvalExpiryMs,
      status: "PENDING",
      resolvedAt: null,
      lastPriceAtRequest: this.snapshotValue.lastPrice,
    };
    this.pendingApprovals.set(id, request);
    this.executionJournalRecorder.recordStrategyApproval("STRATEGY_APPROVAL_REQUESTED", { ...request }, now);
    this.snapshotValue.strategy.pendingApprovals = this.getPendingApprovals();
    this.emitSnapshot();
  }

  expirePendingApprovals(now) {
    for (const request of this.pendingApprovals.values()) {
      if (request.status !== "PENDING" || now < request.expiresAt) continue;
      request.status = "EXPIRED";
      request.resolvedAt = now;
      this.executionJournalRecorder.recordStrategyApproval("STRATEGY_APPROVAL_EXPIRED", { ...request }, now);
    }
  }

  approveOrder(id) {
    const now = this.now();
    this.expirePendingApprovals(now);
    const request = this.pendingApprovals.get(String(id));
    if (!request || request.status !== "PENDING") {
      throw new StrategyApprovalError(
        "승인 대기 중인 요청을 찾을 수 없습니다(이미 처리됐거나 만료됨).",
        "STRATEGY_APPROVAL_NOT_FOUND",
      );
    }
    request.status = "APPROVED";
    request.resolvedAt = now;
    this.executionJournalRecorder.recordStrategyApproval("STRATEGY_APPROVAL_APPROVED", { ...request }, now);
    const order = this.executeStrategyIntent({ side: request.side, quantity: request.quantity, reason: request.reason }, now);
    this.snapshotValue.strategy.pendingApprovals = this.getPendingApprovals();
    this.emitSnapshot();
    return order;
  }

  rejectOrder(id) {
    const now = this.now();
    this.expirePendingApprovals(now);
    const request = this.pendingApprovals.get(String(id));
    if (!request || request.status !== "PENDING") {
      throw new StrategyApprovalError(
        "승인 대기 중인 요청을 찾을 수 없습니다(이미 처리됐거나 만료됨).",
        "STRATEGY_APPROVAL_NOT_FOUND",
      );
    }
    request.status = "REJECTED";
    request.resolvedAt = now;
    this.executionJournalRecorder.recordStrategyApproval("STRATEGY_APPROVAL_REJECTED", { ...request }, now);
    this.snapshotValue.strategy.pendingApprovals = this.getPendingApprovals();
    this.emitSnapshot();
    return structuredClone(request);
  }

  getPendingApprovals() {
    return [...this.pendingApprovals.values()]
      .sort((left, right) => right.requestedAt - left.requestedAt)
      .slice(0, 20)
      .map((request) => structuredClone(request));
  }

  captureExecutionJournal() {
    try {
      return this.executionJournalRecorder.capture(this.trader.account);
    } catch (error) {
      this.haltForExecutionJournalError();
      throw error;
    }
  }

  haltForExecutionJournalError() {
    this.killSwitch = true;
    this.autoPaperTrading = false;
    if (this.snapshotValue?.system) {
      this.snapshotValue.system.killSwitch = true;
      this.snapshotValue.system.autoPaperTrading = false;
    }
  }

  emitSnapshot() { this.emit("snapshot", this.snapshot()); }
}

function normalizeRuntimeInstrument(input, selectedAt) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InstrumentSwitchError(
      "선택 종목 정보가 올바르지 않습니다.",
      "INSTRUMENT_SWITCH_INVALID",
      400,
    );
  }
  const symbol = String(input.symbol ?? "").trim().toUpperCase();
  const symbolName = String(input.symbolName ?? "").trim();
  if (!/^(?:\d{6}|Q\d{6})$/.test(symbol) || !symbolName) {
    throw new InstrumentSwitchError(
      "선택 종목 코드와 이름이 올바르지 않습니다.",
      "INSTRUMENT_SWITCH_INVALID",
      400,
    );
  }
  return {
    symbol,
    symbolName,
    market: optionalText(input.market),
    securityType: optionalText(input.securityType),
    initialPrice: positiveNumber(input.initialPrice, "initialPrice"),
    previousClose: positiveNumber(input.previousClose, "previousClose"),
    tickSize: positiveNumber(input.tickSize, "tickSize"),
    priceSource: String(input.priceSource ?? "KIS_PROD_READ_ONLY"),
    quoteFetchedAt: nullableTimestamp(input.quoteFetchedAt),
    selectedAt,
  };
}

function positiveNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new InstrumentSwitchError(
      `${field}는 양수여야 합니다.`,
      "INSTRUMENT_SWITCH_INVALID",
      400,
    );
  }
  return number;
}

function optionalText(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  return text || null;
}

function nullableTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
