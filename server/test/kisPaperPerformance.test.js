import assert from "node:assert/strict";
import test from "node:test";
import { KisPaperPerformanceTracker, computePerformanceReport } from "../domain/kisPaperPerformance.js";

class MemoryJournal {
  constructor(events = []) { this.events = structuredClone(events); }
  append(type, payload, timestamp) {
    const event = { sequence: this.events.length + 1, type, payload: structuredClone(payload), timestamp };
    this.events.push(event);
    return structuredClone(event);
  }
  readAll() { return structuredClone(this.events); }
}

const NOW = Date.parse("2026-08-04T01:00:00Z");

function order({
  orderNumber,
  orderOrganizationNumber = "00950",
  symbol = "005930",
  side,
  executedQuantity,
  averageExecutedPrice,
  orderedAt = NOW,
} = {}) {
  return { orderNumber, orderOrganizationNumber, symbol, side, executedQuantity, averageExecutedPrice, orderedAt };
}

test("records an equity snapshot and computes max drawdown from the equity curve", () => {
  const journal = new MemoryJournal();
  let clock = NOW;
  const tracker = new KisPaperPerformanceTracker({ journal, now: () => clock });

  tracker.record({ balance: { summary: { totalEvaluationAmount: 10_000_000, evaluationProfitLoss: 0 } }, orderHistory: { orders: [] } });
  clock += 60_000;
  tracker.record({ balance: { summary: { totalEvaluationAmount: 9_000_000, evaluationProfitLoss: -1_000_000 } }, orderHistory: { orders: [] } });
  clock += 60_000;
  tracker.record({ balance: { summary: { totalEvaluationAmount: 9_500_000, evaluationProfitLoss: -500_000 } }, orderHistory: { orders: [] } });

  const report = tracker.report();
  assert.equal(report.equity.snapshotCount, 3);
  assert.equal(report.equity.peak, 10_000_000);
  assert.equal(report.equity.maxDrawdownAmount, 1_000_000);
  assert.equal(report.equity.maxDrawdownPct, 0.1);
  assert.equal(report.equity.current, 9_500_000);
  assert.equal(report.equity.currentDrawdownAmount, 500_000);
});

test("matches a buy fill against a later sell fill using FIFO cost basis for realized P&L", () => {
  const journal = new MemoryJournal();
  const tracker = new KisPaperPerformanceTracker({ journal, now: () => NOW });

  tracker.record({
    balance: { summary: { totalEvaluationAmount: 10_000_000 } },
    orderHistory: {
      orders: [order({ orderNumber: "1", side: "BUY", executedQuantity: 10, averageExecutedPrice: 70_000, orderedAt: NOW - 2_000 })],
    },
  });
  tracker.record({
    balance: { summary: { totalEvaluationAmount: 10_050_000 } },
    orderHistory: {
      orders: [
        order({ orderNumber: "1", side: "BUY", executedQuantity: 10, averageExecutedPrice: 70_000, orderedAt: NOW - 2_000 }),
        order({ orderNumber: "2", side: "SELL", executedQuantity: 10, averageExecutedPrice: 75_000, orderedAt: NOW - 1_000 }),
      ],
    },
  });

  const report = tracker.report();
  assert.equal(report.trades.realizedCount, 1);
  assert.equal(report.trades.totalRealizedPnl, 50_000);
  assert.equal(report.trades.wins, 1);
  assert.equal(report.trades.losses, 0);
  assert.equal(report.trades.costBasisIncompleteQuantity, 0);
});

test("resetAt excludes trades closed before it from the report but keeps the execution journal untouched", () => {
  const events = [
    fillEvent({ orderNumber: "b1", side: "BUY", deltaQuantity: 10, executedPrice: 70_000, orderedAt: NOW - 100_000 }),
    fillEvent({ orderNumber: "s1", side: "SELL", deltaQuantity: 10, executedPrice: 60_000, orderedAt: NOW - 90_000 }),
    fillEvent({ orderNumber: "b2", side: "BUY", deltaQuantity: 5, executedPrice: 70_000, orderedAt: NOW - 1_000 }),
    fillEvent({ orderNumber: "s2", side: "SELL", deltaQuantity: 5, executedPrice: 75_000, orderedAt: NOW }),
  ];

  const full = computePerformanceReport(events, { now: NOW });
  assert.equal(full.resetAt, null);
  assert.equal(full.trades.realizedCount, 2);

  const scoped = computePerformanceReport(events, { now: NOW, resetAt: NOW - 50_000 });
  assert.equal(scoped.resetAt, NOW - 50_000);
  assert.equal(scoped.trades.realizedCount, 1);
  assert.equal(scoped.trades.totalNetPnl > 0, true);
  // 원본 이벤트 배열은 그대로다 — resetAt은 표시 범위만 좁히고 저널을 자르지 않는다.
  assert.equal(events.length, 4);
});

test("KisPaperPerformanceTracker.setResetAt changes what future report() calls include", () => {
  const journal = new MemoryJournal();
  const tracker = new KisPaperPerformanceTracker({ journal, now: () => NOW });
  tracker.record({
    balance: { summary: { totalEvaluationAmount: 10_000_000 } },
    orderHistory: {
      orders: [
        order({ orderNumber: "1", side: "BUY", executedQuantity: 10, averageExecutedPrice: 70_000, orderedAt: NOW - 100_000 }),
        order({ orderNumber: "2", side: "SELL", executedQuantity: 10, averageExecutedPrice: 60_000, orderedAt: NOW - 90_000 }),
      ],
    },
  });

  assert.equal(tracker.report().trades.realizedCount, 1);
  tracker.setResetAt(NOW - 50_000);
  assert.equal(tracker.report().trades.realizedCount, 0);
  assert.equal(tracker.report().resetAt, NOW - 50_000);
  tracker.setResetAt(null);
  assert.equal(tracker.report().trades.realizedCount, 1);
});

test("a sell fill with no matching buy lot is excluded from realized P&L and flagged incomplete", () => {
  const events = [
    fillEvent({ orderNumber: "9", side: "SELL", deltaQuantity: 5, executedPrice: 50_000, orderedAt: NOW }),
  ];
  const report = computePerformanceReport(events, { now: NOW });
  assert.equal(report.trades.realizedCount, 0);
  assert.equal(report.trades.costBasisIncompleteQuantity, 5);
});

test("counts the current and historical maximum consecutive realized-loss streaks", () => {
  const events = [
    fillEvent({ orderNumber: "b1", side: "BUY", deltaQuantity: 1, executedPrice: 100, orderedAt: NOW - 5_000 }),
    fillEvent({ orderNumber: "s1", side: "SELL", deltaQuantity: 1, executedPrice: 90, orderedAt: NOW - 4_000 }),
    fillEvent({ orderNumber: "b2", side: "BUY", deltaQuantity: 1, executedPrice: 100, orderedAt: NOW - 3_000 }),
    fillEvent({ orderNumber: "s2", side: "SELL", deltaQuantity: 1, executedPrice: 110, orderedAt: NOW - 2_000 }),
    fillEvent({ orderNumber: "b3", side: "BUY", deltaQuantity: 1, executedPrice: 100, orderedAt: NOW - 1_000 }),
    fillEvent({ orderNumber: "s3", side: "SELL", deltaQuantity: 1, executedPrice: 80, orderedAt: NOW }),
    fillEvent({ orderNumber: "b4", side: "BUY", deltaQuantity: 1, executedPrice: 100, orderedAt: NOW + 1_000 }),
    fillEvent({ orderNumber: "s4", side: "SELL", deltaQuantity: 1, executedPrice: 70, orderedAt: NOW + 2_000 }),
  ];
  const report = computePerformanceReport(events, { now: NOW });
  assert.equal(report.trades.realizedCount, 4);
  assert.equal(report.trades.consecutiveLossStreak, 2);
  assert.equal(report.trades.maxConsecutiveLossStreak, 2);
});

test("restarting the tracker replays the journal and does not double-count already observed fills", () => {
  const journal = new MemoryJournal();
  const first = new KisPaperPerformanceTracker({ journal, now: () => NOW });
  first.record({
    balance: { summary: { totalEvaluationAmount: 10_000_000 } },
    orderHistory: { orders: [order({ orderNumber: "1", side: "BUY", executedQuantity: 10, averageExecutedPrice: 70_000, orderedAt: NOW })] },
  });

  const second = new KisPaperPerformanceTracker({ journal, now: () => NOW + 1_000 });
  second.record({
    balance: { summary: { totalEvaluationAmount: 10_000_000 } },
    orderHistory: { orders: [order({ orderNumber: "1", side: "BUY", executedQuantity: 10, averageExecutedPrice: 70_000, orderedAt: NOW })] },
  });

  const fillEvents = journal.readAll().filter((event) => event.type === "BROKER_FILL_OBSERVED");
  assert.equal(fillEvents.length, 1);
});

function fillEvent({ orderNumber, side, deltaQuantity, executedPrice, orderedAt }) {
  return {
    type: "BROKER_FILL_OBSERVED",
    timestamp: orderedAt,
    payload: {
      day: "2026-08-04",
      capturedAt: orderedAt,
      orderedAt,
      orderNumber,
      orderOrganizationNumber: "00950",
      symbol: "005930",
      side,
      deltaQuantity,
      executedPrice,
      cumulativeExecutedQuantity: deltaQuantity,
    },
  };
}

test("operational stats report days since the last incident, not a live-trading gate", () => {
  const dayMs = 24 * 60 * 60 * 1_000;
  const events = [
    { sequence: 1, type: "BROKER_ORDER_COMMAND", payload: {}, timestamp: NOW - 10 * dayMs },
    { sequence: 2, type: "BROKER_ORDER_UNKNOWN", payload: {}, timestamp: NOW - 6 * dayMs },
    { sequence: 3, type: "BROKER_RECONCILIATION_MISMATCH", payload: {}, timestamp: NOW - 3 * dayMs },
  ];
  const report = computePerformanceReport(events, { now: NOW });
  assert.equal(report.operational.trackingStartedAt, NOW - 10 * dayMs);
  assert.equal(report.operational.lastIncidentAt, NOW - 3 * dayMs);
  assert.equal(report.operational.daysSinceLastIncident, 3);
});

test("operational stats fall back to time since tracking began when there has never been an incident", () => {
  const dayMs = 24 * 60 * 60 * 1_000;
  const events = [
    { sequence: 1, type: "BROKER_ORDER_COMMAND", payload: {}, timestamp: NOW - 5 * dayMs },
    { sequence: 2, type: "BROKER_ORDER_RESULT", payload: {}, timestamp: NOW - 5 * dayMs },
  ];
  const report = computePerformanceReport(events, { now: NOW });
  assert.equal(report.operational.lastIncidentAt, null);
  assert.equal(report.operational.daysSinceLastIncident, 5);
});

test("operational stats are null when the journal has no events at all", () => {
  const report = computePerformanceReport([], { now: NOW });
  assert.equal(report.operational.trackingStartedAt, null);
  assert.equal(report.operational.lastIncidentAt, null);
  assert.equal(report.operational.daysSinceLastIncident, null);
});

// 판정 기준(docs/AUTO_TRADING_PAPER_DESIGN.md §8)은 비용 차감 후 순익을 쓴다.
// 비용을 빼지 않으면 총이익 소폭 플러스인 전략이 실제로는 손실인데 통과해버린다.
test("실현손익에 왕복 비용을 반영한 netPnl을 산출한다", () => {
  const COST = { buyCommissionBps: 1.40527, sellCommissionBps: 1.40527, sellTaxBps: 20 };
  const events = [
    { type: "BROKER_FILL_OBSERVED", timestamp: 1_000, payload: {
      day: "2026-09-11", capturedAt: 1_000, orderedAt: 1_000, orderNumber: "1",
      orderOrganizationNumber: "A", symbol: "005930", side: "BUY",
      deltaQuantity: 10, executedPrice: 100_000, cumulativeExecutedQuantity: 10,
    } },
    { type: "BROKER_FILL_OBSERVED", timestamp: 2_000, payload: {
      day: "2026-09-11", capturedAt: 2_000, orderedAt: 2_000, orderNumber: "2",
      orderOrganizationNumber: "A", symbol: "005930", side: "SELL",
      deltaQuantity: 10, executedPrice: 100_200, cumulativeExecutedQuantity: 10,
    } },
  ];
  const report = computePerformanceReport(events, { now: 3_000, costModel: COST });
  const trade = report.trades.recent.at(-1);

  // 매수 100만, 매도 100.2만 → 총이익 2,000원
  assert.equal(trade.grossPnl, 2_000);
  // 비용: 매수 1,000,000×0.0140527% + 매도 1,002,000×0.0140527% + 세금 1,002,000×0.2%
  // 1.40527bp = 0.000140527, 20bp = 0.002
  const expectedCost = 1_000_000 * 0.000140527 + 1_002_000 * 0.000140527 + 1_002_000 * 0.002;
  assert.ok(Math.abs(trade.totalCost - expectedCost) < 0.01, `비용 계산 불일치: ${trade.totalCost}`);
  // 순익은 총이익보다 작고, 이 경우 음수다 — 세금 2,004원이 총이익 2,000원을 넘는다
  assert.ok(trade.netPnl < trade.grossPnl);
  assert.ok(trade.netPnl < 0, `비용 차감 후에는 손실이어야 한다: ${trade.netPnl}`);

  assert.equal(report.trades.totalRealizedPnl, 2_000, "총손익 계약은 유지한다");
  assert.ok(report.trades.totalNetPnl < 0);
  assert.equal(report.trades.winRate, 1, "총손익 기준 승률은 100%");
  assert.equal(report.trades.netWinRate, 0, "비용 차감 후 승률은 0%");
  assert.equal(report.costModel.source, "CONFIGURED_ESTIMATE");
});

test("비용 모델을 지정하지 않으면 기본값을 쓴다", () => {
  const report = computePerformanceReport([], { now: 1_000 });
  assert.equal(report.costModel.sellTaxBps, 20);
  assert.equal(report.costModel.buyCommissionBps, 1.40527);
  assert.match(report.costModel.warning, /정산내역과 반드시 대사/);
});
