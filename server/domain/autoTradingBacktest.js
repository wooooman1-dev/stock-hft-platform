// 모의계좌 자동매매 백테스트 (2026-10-02)
//
// 실시간 연구 저널(.pulsehft/realtime-research/*.jsonl)을 시간순으로 다시 흘리면서
// 실제 KisPaperAutoTrader를 그대로 돌린다. 진입·청산 판단 로직을 다시 구현하지 않으므로
// 설정을 바꿨을 때 실제 자동매매가 어떻게 달라지는지를 같은 코드로 비교할 수 있다.
//
// 체결 모델은 단순하다: 시장가 매수는 그 순간 최우선 매도호가, 시장가 매도는 최우선
// 매수호가에 전량 즉시 체결된다고 본다. 호가 잔량 소진·부분체결·주문 지연(실측 10~17초)은
// 반영하지 않으므로 실제보다 낙관적이다.

import { KisPaperAutoTrader } from "./kisPaperAutoTrader.js";
import { evaluateRealtimeConfirmation } from "./realtimeConfirmationEngine.js";
import { DEFAULT_RECOMMENDATION_SETTINGS } from "./recommendationSettings.js";

export async function backtestAutoTrading(events, {
  settings = {},
  costModel = {
    buyCommissionBps: DEFAULT_RECOMMENDATION_SETTINGS.buyCommissionBps,
    sellCommissionBps: DEFAULT_RECOMMENDATION_SETTINGS.sellCommissionBps,
    sellTaxBps: DEFAULT_RECOMMENDATION_SETTINGS.sellTaxBps,
  },
  initialCash = 10_000_000,
  limits = { maxOrderQuantity: 100, maxOrderValue: 1_000_000 },
  evaluatorOptions = {},
} = {}) {
  if (!Array.isArray(events)) throw new TypeError("events는 배열이어야 합니다.");
  const ordered = [...events]
    .filter((event) => Number.isFinite(Number(event?.timestamp)))
    .sort((a, b) => a.timestamp - b.timestamp || (a.sequence ?? 0) - (b.sequence ?? 0));

  const clock = { now: ordered[0]?.timestamp ?? 0 };
  const candidates = new Map();
  const snapshots = new Map();
  const portfolio = { cash: initialCash, positions: new Map() };
  const fills = [];
  const realizedTrades = [];
  const listeners = {};
  const realtimeClient = {
    on(event, listener) { listeners[event] = listener; },
    off(event) { delete listeners[event]; },
    watchSymbols() {},
  };
  const orderService = {
    journal: null,
    status: () => ({
      killSwitch: false,
      manualKillSwitch: false,
      unknownResult: false,
      reconciliation: { status: "CONSISTENT" },
      limits,
    }),
    getPerformance: () => ({ available: true, trades: { recent: realizedTrades } }),
    async submitOrder(order) {
      return fill(order);
    },
  };
  const trader = new KisPaperAutoTrader({
    orderService,
    // 체결이 즉시 잔고에 반영되므로 잔고 반영 대기는 필요 없다.
    settings: { ...settings, enabled: true, settlementGraceMs: 0 },
    costModel,
    realtimeClient,
    now: () => clock.now,
  });
  // 판단 기록은 최근 200건만 남으므로, 진입 차단 사유는 기록되는 순간 센다.
  const skipReasons = {};
  const record = trader.record.bind(trader);
  trader.record = (decision) => {
    tallySkip(decision);
    return record(decision);
  };
  const intervalMs = trader.settings.evaluationIntervalMs;
  let nextEvaluationAt = clock.now;
  let evaluationCount = 0;

  for (const event of ordered) {
    clock.now = event.timestamp;
    while (nextEvaluationAt <= clock.now) {
      clock.now = nextEvaluationAt;
      await runCycle();
      nextEvaluationAt += intervalMs;
      clock.now = event.timestamp;
    }

    if (event.type === "SCANNER_REFRESH") {
      candidates.clear();
      for (const candidate of event.payload?.candidates ?? []) {
        if (candidate?.symbol) candidates.set(String(candidate.symbol), candidate);
      }
      continue;
    }
    if (event.type !== "REALTIME_MARKET_DATA") continue;
    const incoming = event.payload?.snapshot ?? event.payload;
    const symbol = String(incoming?.symbol ?? "");
    if (!symbol) continue;
    // 호가와 체결은 따로 들어오므로 마지막 값을 합쳐 둔다(실시간 클라이언트와 같은 모양).
    const previous = snapshots.get(symbol) ?? {};
    const merged = {
      ...previous,
      ...incoming,
      orderBook: incoming.orderBook ?? previous.orderBook ?? null,
      trade: incoming.trade ?? previous.trade ?? null,
    };
    merged.latestAt = Math.max(
      Number(merged.orderBook?.receivedAt ?? 0),
      Number(merged.trade?.receivedAt ?? 0),
    ) || event.timestamp;
    snapshots.set(symbol, merged);
    if (portfolio.positions.has(symbol) && merged.trade && listeners.marketData) {
      listeners.marketData(merged);
      // 틱으로 낸 매도(submit)는 기다리지 않는 비동기라, 다음 이벤트 전에 끝나게 한다.
      await flushMicrotasks();
    }
  }

  // 끝까지 들고 있던 포지션은 마지막 매수호가로 평가만 한다(실제로 판 것이 아님).
  const openPositions = [...portfolio.positions].map(([symbol, position]) => {
    const exitPrice = bestBid(symbol) ?? lastPrice(symbol) ?? position.averagePrice;
    return { symbol, ...position, markPrice: exitPrice, ...pnl(position, exitPrice) };
  });

  return {
    model: "IMMEDIATE_TOUCH_FILL",
    firstTimestamp: ordered[0]?.timestamp ?? null,
    lastTimestamp: ordered.at(-1)?.timestamp ?? null,
    evaluationCount,
    settings: trader.settings,
    summary: summarize(realizedTrades),
    trades: realizedTrades,
    openPositions,
    fills,
    entrySkipReasons: skipReasons,
    warnings: [
      "시장가 주문이 그 순간 최우선 호가에 전량 즉시 체결된다고 가정했습니다(호가 소진·부분체결·주문 지연 미반영).",
      "기록 시간이 짧으면 표본이 작아 설정 조정 근거로 부족합니다.",
    ],
  };

  async function runCycle() {
    evaluationCount += 1;
    const ranked = [...candidates.values()]
      .sort((a, b) => (Number(a.rank) || Infinity) - (Number(b.rank) || Infinity))
      .map((candidate) => ({
        ...candidate,
        realtime: evaluateRealtimeConfirmation(candidate, snapshots.get(candidate.symbol) ?? null, {
          now: clock.now,
          minimumExecutionStrength: DEFAULT_RECOMMENDATION_SETTINGS.minimumExecutionStrength,
          maximumRealtimeChaseBps: DEFAULT_RECOMMENDATION_SETTINGS.maximumRealtimeChaseBps,
          ...evaluatorOptions,
        }),
      }));
    await trader.evaluate({ candidates: ranked, balance: currentBalance() });
  }

  function currentBalance() {
    let equity = portfolio.cash;
    const positions = [];
    for (const [symbol, position] of portfolio.positions) {
      const price = lastPrice(symbol) ?? position.averagePrice;
      equity += price * position.quantity;
      positions.push({ symbol, name: position.name, quantity: position.quantity, averagePrice: position.averagePrice, currentPrice: price });
    }
    return { positions, summary: { cash: portfolio.cash, totalEvaluationAmount: equity } };
  }

  function fill(order) {
    const symbol = String(order.symbol);
    const price = order.side === "BUY"
      ? bestAsk(symbol) ?? lastPrice(symbol)
      : bestBid(symbol) ?? lastPrice(symbol);
    if (!price) return { clientOrderId: order.clientOrderId, status: "REJECTED" };
    const record = {
      at: clock.now, side: order.side, symbol, quantity: order.quantity, price, reason: order.reason ?? null,
    };
    fills.push(record);
    if (order.side === "BUY") {
      const existing = portfolio.positions.get(symbol);
      const quantity = (existing?.quantity ?? 0) + order.quantity;
      const averagePrice = existing
        ? (existing.averagePrice * existing.quantity + price * order.quantity) / quantity
        : price;
      portfolio.positions.set(symbol, {
        name: candidates.get(symbol)?.name ?? existing?.name ?? null,
        quantity, averagePrice, openedAt: existing?.openedAt ?? clock.now,
      });
      portfolio.cash -= price * order.quantity * (1 + costModel.buyCommissionBps / 10_000);
    } else {
      const position = portfolio.positions.get(symbol);
      if (!position) return { clientOrderId: order.clientOrderId, status: "REJECTED" };
      const quantity = Math.min(order.quantity, position.quantity);
      const sellCostBps = costModel.sellCommissionBps + costModel.sellTaxBps;
      portfolio.cash += price * quantity * (1 - sellCostBps / 10_000);
      realizedTrades.push({
        symbol,
        name: position.name,
        quantity,
        entryPrice: position.averagePrice,
        exitPrice: price,
        openedAt: position.openedAt,
        closedAt: clock.now,
        heldMs: clock.now - position.openedAt,
        exitReason: order.reason ?? null,
        ...pnl({ ...position, quantity }, price),
      });
      if (quantity >= position.quantity) portfolio.positions.delete(symbol);
      else portfolio.positions.set(symbol, { ...position, quantity: position.quantity - quantity });
    }
    return { clientOrderId: order.clientOrderId, status: "ACCEPTED" };
  }

  function pnl(position, exitPrice) {
    const grossPnl = (exitPrice - position.averagePrice) * position.quantity;
    const totalCost = position.averagePrice * position.quantity * costModel.buyCommissionBps / 10_000
      + exitPrice * position.quantity * (costModel.sellCommissionBps + costModel.sellTaxBps) / 10_000;
    const netPnl = grossPnl - totalCost;
    return {
      grossPnl: round(grossPnl),
      totalCost: round(totalCost),
      netPnl: round(netPnl),
      netReturnBps: round((netPnl / (position.averagePrice * position.quantity)) * 10_000),
    };
  }

  function bestAsk(symbol) {
    return positiveOrNull(snapshots.get(symbol)?.orderBook?.bestAsk);
  }

  function bestBid(symbol) {
    return positiveOrNull(snapshots.get(symbol)?.orderBook?.bestBid);
  }

  function lastPrice(symbol) {
    return positiveOrNull(snapshots.get(symbol)?.trade?.currentPrice);
  }

  // 후보별 진입 차단 사유 — "왜 안 샀는지"를 설정별로 비교한다. ENTRY_READY가 아닌
  // 후보(NOT_ENTRY_READY)는 매 주기 수십 건이라 따로 세지 않는다.
  function tallySkip(decision) {
    if (decision?.action !== "SKIP") return;
    if (decision.reason !== "NO_ELIGIBLE_CANDIDATE") {
      skipReasons[decision.reason] = (skipReasons[decision.reason] ?? 0) + 1;
      return;
    }
    for (const item of decision.evaluated ?? []) {
      if (item.reason === "NOT_ENTRY_READY") continue;
      skipReasons[item.reason] = (skipReasons[item.reason] ?? 0) + 1;
    }
  }
}

function summarize(trades) {
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  const totalNetPnl = trades.reduce((sum, trade) => sum + trade.netPnl, 0);
  const averageWin = wins.length ? wins.reduce((sum, trade) => sum + trade.netPnl, 0) / wins.length : null;
  const averageLoss = losses.length ? losses.reduce((sum, trade) => sum + trade.netPnl, 0) / losses.length : null;
  const byExitReason = {};
  for (const trade of trades) byExitReason[trade.exitReason] = (byExitReason[trade.exitReason] ?? 0) + 1;
  return {
    tradeCount: trades.length,
    wins: wins.length,
    losses: losses.length,
    netWinRate: trades.length ? round(wins.length / trades.length, 4) : null,
    totalNetPnl: round(totalNetPnl),
    averageNetPnl: trades.length ? round(totalNetPnl / trades.length) : null,
    averageNetReturnBps: trades.length
      ? round(trades.reduce((sum, trade) => sum + trade.netReturnBps, 0) / trades.length)
      : null,
    averageWin: averageWin === null ? null : round(averageWin),
    averageLoss: averageLoss === null ? null : round(averageLoss),
    payoffRatio: averageWin !== null && averageLoss !== null && averageLoss !== 0
      ? round(averageWin / Math.abs(averageLoss), 3)
      : null,
    byExitReason,
  };
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function positiveOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function round(value, digits = 2) {
  const power = 10 ** digits;
  return Math.round(value * power) / power;
}
