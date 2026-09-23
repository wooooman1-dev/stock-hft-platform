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
    // 종목별로 따로 추적한다(피크가격·보유시작시각은 종목마다 다르다).
    this.riskTrackers = new Map();
    this.halt = null;
    this.lastOrderAt = 0;
    // 평가가 겹쳐 돌면 둘 다 "보유 없음"을 보고 각자 진입한다(2026-09-11: 1ms 차이로
    // 042700을 4주씩 두 번 매수해 저널 8주 / 잔고 4주 불일치가 났다).
    this.evaluating = false;
    // 주문을 낸 뒤 잔고에 반영되기까지는 그 종목이 보유 없음으로 보인다 — 그 구간에는
    // 같은 종목에 또 진입하지 않는다. 종목별로 따로 대기한다(동시 보유 여러 종목).
    this.pendingOrders = new Map();
    this.holdings = new Map();
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
      pendingOrders: [...this.pendingOrders.values()].map((order) => ({ ...order })),
      holdings: [...this.holdings.values()].map((holding) => ({ ...holding })),
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

  // 동시에 최대 settings.maxConcurrentPositions종목까지 들고 간다. 보유 중인
  // 종목은 전부 매 주기 청산 조건을 평가하고(여러 종목이 동시에 손절 조건에
  // 닿으면 전부 이번 주기에 청산한다 — 보호 조치는 미룰수록 위험하다), 신규
  // 진입은 한 주기에 최대 1건만 낸다(기존 쿨다운 설계 유지).
  async evaluateOnce({ candidates = [], balance = null, marketTime = null } = {}) {
    const at = this.now();
    if (!this.settings.enabled) return this.record({ action: "DISABLED", at });

    // 가드는 먼저 평가해 멈춤 상태를 갱신하되, 청산 경로는 통과시킨다.
    const guard = this.checkServiceGuards();
    this.prunePendingOrders(at);

    const positions = this.resolvePositions(balance);
    const heldSymbols = new Set(positions.map((position) => position.symbol));

    const exitDecisions = [];
    for (const position of positions) {
      exitDecisions.push(await this.evaluateExit({ position, at, marketTime }));
    }
    // 반환값은 이번 주기의 대표 결과 하나다 — 그냥 유지(HOLD)보다 실제로 일어난
    // 일(매도·청산차단 등)을 우선한다. 모든 개별 결정은 decisions 기록에 전부 남는다.
    const eventfulExit = exitDecisions.find((decision) => decision.action !== "HOLD");

    if (this.halt) {
      const decision = this.record({
        action: "HALTED", at, blocks: "ENTRY",
        reason: this.halt.code, detail: this.halt.message,
      });
      return eventfulExit ?? decision;
    }
    if (guard) {
      const decision = this.record({ ...guard, at });
      return eventfulExit ?? decision;
    }

    const pendingCount = [...this.pendingOrders.keys()]
      .filter((symbol) => !heldSymbols.has(symbol)).length;
    if (positions.length + pendingCount >= this.settings.maxConcurrentPositions) {
      const decision = this.record({
        action: "SKIP", at, reason: "AT_CAPACITY",
        held: positions.length, pending: pendingCount, max: this.settings.maxConcurrentPositions,
      });
      return eventfulExit ?? decision;
    }

    const entryDecision = await this.evaluateEntry({ candidates, balance, at, heldSymbols });
    if (eventfulExit) return eventfulExit;
    // 신규 진입이 실제로 나갔으면 그게 이번 주기의 대표 결과다. 아니면(진입 없음)
    // 보유 중인 종목의 상태(HOLD)를 대표로 보여준다 — "아무 것도 안 샀다"보다
    // "무엇을 들고 있는지"가 더 유용한 기본 정보다.
    if (entryDecision.action === "ORDER") return entryDecision;
    return exitDecisions[0] ?? entryDecision;
  }

  // 주문 상태가 불확실하거나 대사가 확정적으로 어긋나면 다음 주문을 내지 않는다.
  //
  // status().killSwitch는 수동 킬 스위치·결과불명·대사차단을 전부 하나의 불리언으로
  // 뭉친 값이다 — 그런데 대사차단(reconciliation.blocked)은 "확정 불일치"(MISMATCH)
  // 뿐 아니라 "방금 낸 주문이 아직 KIS에 반영 안 됨"(PENDING, 최대 180초) 같은 정상
  // 대기 상태에도 true가 된다. 예전엔 이 뭉쳐진 killSwitch를 그대로 봐서, 정상적인
  // PENDING 순간에 평가 주기(5초)가 우연히 걸리면 사람이 "멈춤 해제"를 눌러야만
  // 풀리는 halt로 확정돼버렸다(2026-09-23 — 거래 빈도가 올라가면서 이 우연이 계속
  // 반복돼 "또 멈췄다"가 반복됨). 수동 킬 스위치·결과불명은 그대로 즉시 halt하고,
  // 대사 상태는 PENDING·UNAVAILABLE(둘 다 다음 확인에서 스스로 풀림)은 이번 주기만
  // 건너뛰고, MISMATCH·RESOLVED_AWAITING_ACK(사람 확인이 필요한 확정 상태)만 halt한다.
  checkServiceGuards() {
    let serviceStatus;
    try {
      serviceStatus = this.orderService.status();
    } catch (error) {
      const halt = this.setHalt("SERVICE_STATUS_FAILED", `주문 서비스 상태 조회 실패: ${message(error)}`);
      return { action: "HALTED", reason: halt.code, detail: halt.message };
    }
    if (serviceStatus?.manualKillSwitch) {
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
      && (reconciliation === "MISMATCH" || reconciliation === "RESOLVED_AWAITING_ACK")) {
      const halt = this.setHalt(
        "RECONCILIATION_MISMATCH",
        `대사 상태가 ${reconciliation}입니다. 원인을 해소한 뒤 재개하세요.`,
      );
      return { action: "HALTED", reason: halt.code, detail: halt.message };
    }
    if (reconciliation === "PENDING" || reconciliation === "UNAVAILABLE") {
      return {
        action: "WAITING",
        reason: reconciliation === "PENDING" ? "RECONCILIATION_PENDING" : "RECONCILIATION_UNAVAILABLE",
        detail: reconciliation === "PENDING"
          ? "방금 낸 주문이 KIS에 반영되는 걸 기다리는 중입니다."
          : "KIS 계좌 대조 조회가 잠시 실패했습니다. 다음 주기에 다시 시도합니다.",
      };
    }
    return null;
  }

  // 잔고에 수량이 있는 종목을 전부(최대 maxConcurrentPositions개) 돌려준다.
  resolvePositions(balance) {
    const positions = Array.isArray(balance?.positions) ? balance.positions : [];
    const held = positions.filter((item) => Number(item?.quantity) > 0);
    const heldSymbols = new Set(held.map((item) => String(item.symbol ?? "")));
    // 잔고에 반영된 매수는 대기 목록에서 뺀다.
    for (const symbol of [...this.pendingOrders.keys()]) {
      if (heldSymbols.has(symbol)) this.pendingOrders.delete(symbol);
    }
    // 더 이상 들고 있지 않은 종목의 위험 추적기·표시용 스냅샷은 정리한다.
    for (const symbol of [...this.riskTrackers.keys()]) {
      if (!heldSymbols.has(symbol)) this.riskTrackers.delete(symbol);
    }
    for (const symbol of [...this.holdings.keys()]) {
      if (!heldSymbols.has(symbol)) this.holdings.delete(symbol);
    }
    // 화면에 종목코드만 보이면 무엇을 들고 있는지 알 수 없다.
    return held.map((target) => ({
      symbol: String(target.symbol ?? ""),
      name: target.name ? String(target.name) : null,
      quantity: Math.trunc(Number(target.quantity)),
      averagePrice: Number(target.averagePrice),
      currentPrice: Number(target.currentPrice),
      evaluationAmount: numberOrNull(target.evaluationAmount),
      evaluationProfitLoss: numberOrNull(target.evaluationProfitLoss),
      evaluationProfitLossRate: numberOrNull(target.evaluationProfitLossRate),
    }));
  }

  // 주문 직후 잔고 반영 지연 구간(settlementGraceMs)이 지나도 잔고에 안 잡혔으면
  // 대기를 풀어준다 — 주문이 실제로는 거절됐을 수 있으므로 그 종목을 영구히
  // 막지 않는다.
  prunePendingOrders(at) {
    for (const [symbol, pending] of this.pendingOrders) {
      if (at - pending.at >= this.settings.settlementGraceMs) {
        this.pendingOrders.delete(symbol);
      }
    }
  }

  async evaluateExit({ position, at, marketTime }) {
    const lastPrice = Number.isFinite(position.currentPrice) && position.currentPrice > 0
      ? position.currentPrice
      : position.averagePrice;
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) {
      return this.record({ action: "HOLD", at, symbol: position.symbol, reason: "NO_PRICE" });
    }

    let tracker = this.riskTrackers.get(position.symbol);
    if (!tracker) {
      tracker = new PositionRiskTracker();
      this.riskTrackers.set(position.symbol, tracker);
    }
    const risk = tracker.update({
      quantity: position.quantity,
      lastPrice,
      timestamp: at,
    });
    this.holdings.set(position.symbol, {
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
    });

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
      quantity: position.quantity, returnBps: this.holdings.get(position.symbol).returnBps,
    });
  }

  async evaluateEntry({ candidates, balance, at, heldSymbols }) {
    if (at - this.lastOrderAt < this.settings.cooldownMs) {
      return this.record({ action: "SKIP", at, reason: "COOLDOWN" });
    }
    const equity = resolveEquity(balance);
    if (equity === null) return this.record({ action: "SKIP", at, reason: "NO_EQUITY" });

    const evaluated = [];
    for (const candidate of candidates) {
      const symbol = String(candidate?.symbol ?? "");
      // 이미 들고 있거나(다른 슬롯) 매수 반영을 기다리는 중인 종목은 또 사지 않는다.
      if (symbol && (heldSymbols.has(symbol) || this.pendingOrders.has(symbol))) {
        evaluated.push({
          symbol, name: candidate?.name ?? null,
          eligible: false, reason: "ALREADY_HELD_OR_PENDING",
        });
        continue;
      }
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
  //
  // ENTRY_READY는 REST 점수 75 이상(stage === CONFIRMATION_REQUIRED)과 실시간
  // 호가 불균형·체결강도 기준을 전부 "동시에" 만족해야만 켜진다. 한때 WATCH
  // 단계도 확신도 점수(calculateEntryConfidence)가 문턱을 넘으면 진입을 허용하는
  // 완화를 시도했으나(2026-09-17, 거래 빈도를 늘리려는 목적), 2026-09-23 실제
  // 체결 9건을 연구 저널로 대조해보니 9건 중 4건이 WATCH나 심지어 LOW_PRIORITY
  // 단계에서, 반등 근거가 12~21bp(노이즈 수준)뿐인 상태로 진입해 있었다(9건 전부
  // 손실). ENTRY_READY만 허용하도록 되돌린다 — 거래 빈도는 evaluationIntervalMs를
  // 5초로 줄인 것(순간을 놓치는 문제 완화)과 maxEnriched를 늘리는 쪽으로 확보한다.
  checkEntryGate(candidate, equity, at) {
    const symbol = String(candidate?.symbol ?? "");
    if (!symbol) return { eligible: false, reason: "NO_SYMBOL" };
    const state = candidate?.realtime?.state;
    if (state !== "ENTRY_READY") {
      return { eligible: false, reason: "NOT_ENTRY_READY", state: state ?? null };
    }
    const staleMs = quoteAgeMs(candidate, at);
    if (staleMs !== null && staleMs > this.settings.staleQuoteMs) {
      return { eligible: false, reason: "STALE_QUOTE", staleMs };
    }
    // realtimeConfirmationEngine.js는 currentPrice/spreadBps를 candidate.realtime
    // 바로 아래가 아니라 candidate.realtime.metrics 안에 넣는다 — 예전 경로는 항상
    // undefined라 매번 REST 스캔 시점(최대 15초 전) 값으로 조용히 대체되고 있었다
    // (2026-09-17). 실제로 있는 경로를 먼저 본다.
    const price = positiveNumber(candidate?.realtime?.metrics?.currentPrice ?? candidate?.currentPrice);
    if (price === null) return { eligible: false, reason: "NO_PRICE" };

    const spreadTicks = numberOrNull(candidate?.microstructure?.spreadTicks);
    if (spreadTicks !== null && spreadTicks > this.settings.maximumSpreadTicks) {
      return { eligible: false, reason: "SPREAD_TOO_WIDE", spreadTicks };
    }

    const spreadBps = numberOrNull(candidate?.realtime?.metrics?.spreadBps ?? candidate?.microstructure?.spreadBps) ?? 0;
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
    if (side === "BUY") this.pendingOrders.set(symbol, { symbol, name, quantity, at });
    let result;
    try {
      result = await this.orderService.submitOrder({
        clientOrderId,
        side,
        symbol,
        type: "MARKET",
        quantity,
        referencePrice,
        // SOR(Smart Order Routing) — KRX 정규장이든 넥스트레이드 프리마켓·
        // 애프터마켓이든 그 순간 열려 있는 거래소로 KIS가 알아서 라우팅한다
        // (2026-09-17, isKoreaTradingWindow가 08:00~20:00으로 넓어진 것과 짝).
        exchange: "SOR",
        orderBookSnapshot,
        // 이 자동매매(v1, 동시 보유 1종목)는 매도를 손절·익절·트레일링 스톱·최대
        // 보유시간·강제청산 용도로만 낸다 — 매도는 전부 보호청산이다.
        protectiveExit: side === "SELL",
        // KIS에 보내는 필드가 아니라 실행 저널에만 남기는 내부 메모다 — 이게 없으면
        // 매도가 손절/트레일링/신호 중 어느 것 때문이었는지 나중에 복원할 수 없다
        // (2026-09-23, 9연패의 원인이 진입 문제인지 청산 문제인지 판단할 근거가 없어서 추가).
        reason,
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
