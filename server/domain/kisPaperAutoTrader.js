// 모의계좌 자동매매 오케스트레이터 (docs/AUTO_TRADING_PAPER_DESIGN.md)
//
// 추천 스캐너 후보와 보호 청산 로직을 KisPaperOrderService에 잇는다.
// 전략 자체는 새로 만들지 않는다. 진입 게이트와 수량 산정, 중단 조건만 이 계층이 책임진다.
//
// 실전 경로(kisLive*)와는 무관하다. 이 클래스는 모의계좌에만 주문을 낸다.

import { evaluatePositionRiskExit } from "./strategyPolicy.js";
import { PositionRiskTracker } from "./positionRiskTracker.js";
import {
  calculateExpectedNetEdgeBps,
  DEFAULT_AUTO_TRADING_SETTINGS,
  normalizeAutoTradingSettings,
} from "./autoTradingSettings.js";

export class KisPaperAutoTraderError extends Error {
  constructor(message, code = "KIS_PAPER_AUTO_TRADER_ERROR") {
    super(message);
    this.name = "KisPaperAutoTraderError";
    this.code = code;
    this.statusCode = 500;
  }
}

export class KisPaperAutoTrader {
  constructor({
    orderService,
    settings = DEFAULT_AUTO_TRADING_SETTINGS,
    costModel = {},
    now = Date.now,
  } = {}) {
    if (!orderService || typeof orderService.submitOrder !== "function") {
      throw new TypeError("KisPaperOrderService가 필요합니다.");
    }
    if (typeof now !== "function") throw new TypeError("now는 함수여야 합니다.");
    this.orderService = orderService;
    this.settings = normalizeAutoTradingSettings(settings);
    this.costModel = { ...costModel };
    this.now = now;
    this.riskTracker = new PositionRiskTracker();
    this.halt = null;
    this.lastOrderAt = 0;
    // 평가가 겹쳐 돌면 둘 다 "보유 없음"을 보고 각자 진입한다(2026-09-11: 1ms 차이로
    // 042700을 4주씩 두 번 매수해 저널 8주 / 잔고 4주 불일치가 났다).
    this.evaluating = false;
    // 주문을 낸 뒤 잔고에 반영되기까지는 보유 없음으로 보인다. 그 구간에는 진입하지 않는다.
    this.pendingOrder = null;
    this.holding = null;
    this.decisions = [];
  }

  updateSettings(settings) {
    this.settings = normalizeAutoTradingSettings(settings);
    return this.status();
  }

  updateCostModel(costModel) {
    this.costModel = { ...costModel };
    return this.status();
  }

  status() {
    return {
      enabled: this.settings.enabled,
      halted: this.halt !== null,
      haltReason: this.halt ? { ...this.halt } : null,
      settings: { ...this.settings },
      costModel: { ...this.costModel },
      lastOrderAt: this.lastOrderAt || null,
      pendingOrder: this.pendingOrder ? { ...this.pendingOrder } : null,
      holding: this.holding ? { ...this.holding } : null,
      risk: this.riskTracker.snapshot(),
      recentDecisions: this.decisions.slice(-20),
    };
  }

  // 사람이 원인을 확인하고 풀어줄 때까지 멈춘다. 자동 해제는 하지 않는다.
  setHalt(code, message, detail = null) {
    if (this.halt) return this.halt;
    this.halt = { code, message, detail, at: this.now() };
    return this.halt;
  }

  clearHalt() {
    this.halt = null;
    return this.status();
  }

  // 한 번의 평가 주기. 주문을 최대 1건 낸다. 겹쳐 호출되면 뒤의 호출은 건너뛴다.
  //
  // 멈춤(halt)은 *신규 진입만* 막는다. 보호 청산까지 막으면 포지션이 손절·익절·
  // 강제청산 없이 방치된다(2026-09-11: 대사 불일치로 멈춘 뒤 3시간 동안 4주가
  // 보호 없이 남아 있었다). 무언가 잘못됐을 때 포지션을 들고 있는 것이
  // 포지션을 정리하는 것보다 위험하다.
  async evaluate(input = {}) {
    if (this.evaluating) {
      return this.record({ action: "SKIP", at: this.now(), reason: "EVALUATION_IN_FLIGHT" });
    }
    this.evaluating = true;
    try {
      return await this.evaluateOnce(input);
    } finally {
      this.evaluating = false;
    }
  }

  async evaluateOnce({ candidates = [], balance = null, marketTime = null } = {}) {
    const at = this.now();
    if (!this.settings.enabled) return this.record({ action: "DISABLED", at });

    // 가드는 먼저 평가해 멈춤 상태를 갱신하되, 청산 경로는 통과시킨다.
    const guard = this.checkServiceGuards();

    const position = this.resolvePosition(balance);
    if (position) return this.evaluateExit({ position, at, marketTime });

    if (this.halt) {
      return this.record({
        action: "HALTED", at, blocks: "ENTRY",
        reason: this.halt.code, detail: this.halt.message,
      });
    }
    if (guard) return this.record({ ...guard, at });
    return this.evaluateEntry({ candidates, balance, at });
  }

  // 주문 상태가 불확실하거나 대사가 어긋나면 다음 주문을 내지 않는다.
  checkServiceGuards() {
    let serviceStatus;
    try {
      serviceStatus = this.orderService.status();
    } catch (error) {
      const halt = this.setHalt("SERVICE_STATUS_FAILED", `주문 서비스 상태 조회 실패: ${message(error)}`);
      return { action: "HALTED", reason: halt.code, detail: halt.message };
    }
    if (serviceStatus?.killSwitch) {
      const halt = this.setHalt("KILL_SWITCH", "주문 서비스 킬 스위치가 켜져 있습니다.");
      return { action: "HALTED", reason: halt.code, detail: halt.message };
    }
    if (this.settings.haltOnUnknownResult && serviceStatus?.unknownResult) {
      const halt = this.setHalt(
        "UNKNOWN_RESULT",
        "주문 결과가 불확실합니다. 증권사 주문내역과 대조해 해소한 뒤 재개하세요.",
      );
      return { action: "HALTED", reason: halt.code, detail: halt.message };
    }
    const reconciliation = serviceStatus?.reconciliation?.status;
    if (this.settings.haltOnReconciliationMismatch
      && reconciliation && reconciliation !== "CONSISTENT" && reconciliation !== "UNAVAILABLE") {
      const halt = this.setHalt(
        "RECONCILIATION_MISMATCH",
        `대사 상태가 ${reconciliation}입니다. 원인을 해소한 뒤 재개하세요.`,
      );
      return { action: "HALTED", reason: halt.code, detail: halt.message };
    }
    return null;
  }

  // v1은 동시 보유 1종목이다. 잔고에 수량이 있는 종목이 있으면 그것만 본다.
  resolvePosition(balance) {
    const positions = Array.isArray(balance?.positions) ? balance.positions : [];
    const held = positions.filter((item) => Number(item?.quantity) > 0);
    // 잔고에 반영됐으면 대기를 푼다.
    if (this.pendingOrder && held.some((item) => item.symbol === this.pendingOrder.symbol)) {
      this.pendingOrder = null;
    }
    if (held.length === 0) {
      this.riskTracker.reset();
      this.holding = null;
      return null;
    }
    const target = this.holding
      ? held.find((item) => item.symbol === this.holding.symbol) ?? held[0]
      : held[0];
    return {
      symbol: String(target.symbol ?? ""),
      // 화면에 종목코드만 보이면 무엇을 들고 있는지 알 수 없다.
      name: target.name ? String(target.name) : null,
      quantity: Math.trunc(Number(target.quantity)),
      averagePrice: Number(target.averagePrice),
      currentPrice: Number(target.currentPrice),
      evaluationAmount: numberOrNull(target.evaluationAmount),
      evaluationProfitLoss: numberOrNull(target.evaluationProfitLoss),
      evaluationProfitLossRate: numberOrNull(target.evaluationProfitLossRate),
    };
  }

  async evaluateExit({ position, at, marketTime }) {
    const lastPrice = Number.isFinite(position.currentPrice) && position.currentPrice > 0
      ? position.currentPrice
      : position.averagePrice;
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) {
      return this.record({ action: "HOLD", at, symbol: position.symbol, reason: "NO_PRICE" });
    }

    const risk = this.riskTracker.update({
      quantity: position.quantity,
      lastPrice,
      timestamp: at,
    });
    this.holding = {
      symbol: position.symbol,
      name: position.name,
      quantity: position.quantity,
      averagePrice: position.averagePrice,
      currentPrice: lastPrice,
      evaluationProfitLoss: position.evaluationProfitLoss,
      evaluationProfitLossRate: position.evaluationProfitLossRate,
      openedAt: risk.openedAt,
      heldMs: risk.openedAt !== null ? Math.max(0, at - risk.openedAt) : null,
      peakPrice: risk.peakPrice,
      returnBps: position.averagePrice > 0
        ? ((lastPrice - position.averagePrice) / position.averagePrice) * 10_000
        : null,
    };

    // 장 종료 전 강제 청산. 보호 청산보다 우선한다.
    if (this.isForcedExitDue(marketTime ?? at)) {
      return this.submit({
        side: "SELL", symbol: position.symbol, name: position.name,
        quantity: position.quantity,
        referencePrice: lastPrice, reason: "FORCED_EXIT", at,
      });
    }

    const intent = evaluatePositionRiskExit({
      account: { position: { quantity: position.quantity, averagePrice: position.averagePrice } },
      settings: this.riskSettings(),
      now: at,
      lastPrice,
      positionRiskState: risk,
    });
    if (intent) {
      return this.submit({
        side: "SELL", symbol: position.symbol, name: position.name,
        quantity: intent.quantity,
        referencePrice: lastPrice, reason: intent.reason, at, diagnostics: intent.diagnostics,
      });
    }
    return this.record({
      action: "HOLD", at, symbol: position.symbol, name: position.name,
      quantity: position.quantity, returnBps: this.holding.returnBps,
    });
  }

  async evaluateEntry({ candidates, balance, at }) {
    // 직전 주문이 아직 잔고에 안 잡혔으면 "보유 없음"은 착시다. 반영될 때까지 기다린다.
    const pending = this.pendingSettlement(at);
    if (pending) return this.record({ action: "SKIP", at, reason: "AWAITING_SETTLEMENT", pending });
    if (at - this.lastOrderAt < this.settings.cooldownMs) {
      return this.record({ action: "SKIP", at, reason: "COOLDOWN" });
    }
    const equity = resolveEquity(balance);
    if (equity === null) return this.record({ action: "SKIP", at, reason: "NO_EQUITY" });

    const evaluated = [];
    for (const candidate of candidates) {
      const check = this.checkEntryGate(candidate, equity, at);
      evaluated.push({ symbol: candidate?.symbol ?? null, name: candidate?.name ?? null, ...check });
      if (check.eligible) {
        return this.submit({
          side: "BUY", symbol: check.symbol, name: check.name, quantity: check.quantity,
          referencePrice: check.price, reason: "ENTRY_SIGNAL", at,
          diagnostics: { expectedNetEdgeBps: check.expectedNetEdgeBps, equity },
          orderBookSnapshot: check.orderBookSnapshot,
        });
      }
    }
    return this.record({ action: "SKIP", at, reason: "NO_ELIGIBLE_CANDIDATE", evaluated });
  }

  // 진입 게이트: 실시간 확인 통과 + 비용 문턱 + 수량 성립
  checkEntryGate(candidate, equity, at) {
    const symbol = String(candidate?.symbol ?? "");
    if (!symbol) return { eligible: false, reason: "NO_SYMBOL" };
    if (candidate?.realtime?.state !== "ENTRY_READY") {
      return { eligible: false, reason: "NOT_ENTRY_READY", state: candidate?.realtime?.state ?? null };
    }
    const staleMs = quoteAgeMs(candidate, at);
    if (staleMs !== null && staleMs > this.settings.staleQuoteMs) {
      return { eligible: false, reason: "STALE_QUOTE", staleMs };
    }
    const price = positiveNumber(candidate?.realtime?.currentPrice ?? candidate?.currentPrice);
    if (price === null) return { eligible: false, reason: "NO_PRICE" };

    const spreadTicks = numberOrNull(candidate?.microstructure?.spreadTicks ?? candidate?.realtime?.spreadTicks);
    if (spreadTicks !== null && spreadTicks > this.settings.maximumSpreadTicks) {
      return { eligible: false, reason: "SPREAD_TOO_WIDE", spreadTicks };
    }

    const spreadBps = numberOrNull(candidate?.realtime?.spreadBps ?? candidate?.microstructure?.spreadBps) ?? 0;
    const tickSize = positiveNumber(candidate?.price?.tickSize ?? candidate?.tickSize) ?? 0;
    const slippageBps = tickSize > 0 ? (tickSize / price) * 10_000 : 0;
    const expectedNetEdgeBps = calculateExpectedNetEdgeBps({
      takeProfitBps: this.settings.takeProfitBps,
      costModel: this.costModel,
      spreadBps,
      slippageBps,
    });
    if (expectedNetEdgeBps === null) {
      return { eligible: false, reason: "NO_TARGET" };
    }
    if (expectedNetEdgeBps < this.settings.minimumNetEdgeBps) {
      return {
        eligible: false, reason: "BELOW_NET_EDGE",
        expectedNetEdgeBps, required: this.settings.minimumNetEdgeBps, spreadBps, slippageBps,
      };
    }

    const quantity = this.resolveQuantity(equity, price);
    if (quantity < 1) {
      return { eligible: false, reason: "QUANTITY_TOO_SMALL", price, equity };
    }
    return {
      eligible: true, symbol, name: candidate?.name ?? null,
      price, quantity, expectedNetEdgeBps,
      orderBookSnapshot: candidate?.orderBookSnapshot ?? null,
    };
  }

  // 자본 비율로 목표금액을 잡고, 모의계좌 한도로 다시 자른다.
  resolveQuantity(equity, price) {
    const limits = this.orderService.status()?.limits ?? {};
    const maxValue = positiveNumber(limits.maxOrderValue) ?? Infinity;
    const maxQuantity = positiveNumber(limits.maxOrderQuantity) ?? Infinity;
    const target = Math.min(equity * this.settings.positionSizeRatio, maxValue);
    const byValue = Math.floor(target / price);
    return Math.max(0, Math.min(byValue, Math.floor(maxQuantity)));
  }

  // 주문 직후 잔고 반영 지연 구간인지 판정한다. settlementGraceMs가 지나면 포기하고
  // 정상 흐름으로 돌아간다(주문이 거절됐을 수도 있으므로 영구히 막지 않는다).
  pendingSettlement(at) {
    if (!this.pendingOrder) return null;
    if (at - this.pendingOrder.at >= this.settings.settlementGraceMs) {
      this.pendingOrder = null;
      return null;
    }
    return { ...this.pendingOrder };
  }

  isForcedExitDue(timestamp) {
    const configured = this.settings.forcedExitTime;
    if (!configured) return false;
    const [hour, minute] = configured.split(":").map(Number);
    const kst = new Date(Number(timestamp) + 9 * 60 * 60 * 1_000);
    const minutesNow = kst.getUTCHours() * 60 + kst.getUTCMinutes();
    return minutesNow >= hour * 60 + minute;
  }

  riskSettings() {
    return {
      stopLossBps: this.settings.stopLossBps,
      takeProfitBps: this.settings.takeProfitBps,
      trailingStopBps: this.settings.trailingStopBps,
      maxHoldingMs: this.settings.maxHoldingMs,
    };
  }

  async submit({ side, symbol, name = null, quantity, referencePrice, reason, at, diagnostics = null, orderBookSnapshot = null }) {
    const clientOrderId = `AUTO:${side}:${symbol}:${at}`;
    // await 이전에 기록한다. 제출이 끝난 뒤에 갱신하면 그 사이의 평가가 옛 값을 보고
    // 같은 주문을 또 낸다.
    this.lastOrderAt = at;
    if (side === "BUY") this.pendingOrder = { symbol, name, quantity, at };
    let result;
    try {
      result = await this.orderService.submitOrder({
        clientOrderId,
        side,
        symbol,
        type: "MARKET",
        quantity,
        referencePrice,
        exchange: "KRX",
        orderBookSnapshot,
        // 이 자동매매(v1, 동시 보유 1종목)는 매도를 손절·익절·트레일링 스톱·최대
        // 보유시간·강제청산 용도로만 낸다 — 매도는 전부 보호청산이다.
        protectiveExit: side === "SELL",
      });
    } catch (error) {
      // 이미 멈춘 상태에서 청산이 거부되는 것은 새로운 사고가 아니라
      // 멈춤의 결과다. 원인을 덮어쓰지 않고 별개 사유로 드러낸다.
      if (side === "SELL" && this.halt) {
        return this.record({
          action: "EXIT_BLOCKED", at, side, symbol, name, quantity, reason,
          detail: `보호 청산이 차단되었습니다: ${message(error)}`,
          haltReason: this.halt.code,
        });
      }
      const halt = this.setHalt("ORDER_FAILED", `주문 제출 실패: ${message(error)}`, { clientOrderId, side, symbol });
      return this.record({ action: "ORDER_ERROR", at, side, symbol, name, quantity, reason, detail: halt.message });
    }
    if (result?.status === "UNKNOWN_RESULT" && this.settings.haltOnUnknownResult) {
      this.setHalt("UNKNOWN_RESULT", "주문 결과가 불확실합니다. 해소 후 재개하세요.", { clientOrderId });
    }
    return this.record({
      action: "ORDER", at, side, symbol, name, quantity, reason, clientOrderId,
      referencePrice, status: result?.status ?? null, diagnostics,
    });
  }

  record(decision) {
    this.decisions.push(decision);
    if (this.decisions.length > 200) this.decisions.splice(0, this.decisions.length - 200);
    return decision;
  }
}

function resolveEquity(balance) {
  const total = positiveNumber(balance?.summary?.totalEvaluationAmount);
  if (total !== null) return total;
  const cash = positiveNumber(balance?.summary?.cash);
  return cash;
}

function quoteAgeMs(candidate, at) {
  const latest = numberOrNull(candidate?.realtime?.latestAt ?? candidate?.fetchedAt);
  if (latest === null) return null;
  return Math.max(0, Number(at) - latest);
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
