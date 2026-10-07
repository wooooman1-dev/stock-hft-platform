import test from "node:test";
import assert from "node:assert/strict";
import { buildDailyReport, kstDay } from "../domain/dailyReport.js";

const T = Date.parse("2026-10-07T01:00:00Z"); // 10:00 KST

const command = (clientOrderId, side, symbol, timestamp, extra = {}) => ({
  type: "BROKER_ORDER_COMMAND", timestamp,
  payload: { clientOrderId, timestamp, request: { side, symbol }, ...extra },
});
const result = (clientOrderId, orderNumber, timestamp) => ({
  type: "BROKER_ORDER_RESULT", timestamp, payload: { clientOrderId, result: { orderNumber } },
});

test("거래를 청산 사유·진입 유형별로 묶고, 보유 중 최대 상승/하락과 진입 필터 탈락을 함께 낸다", () => {
  const events = [
    command("AUTO:BUY:A:1", "BUY", "A", T, {
      reason: "ENTRY_SIGNAL", context: { candidate: { type: "PULLBACK" }, gate: { executionStrength: 120 } },
    }),
    command("AUTO:SELL:A:2", "SELL", "A", T + 120_000, { reason: "STOP_LOSS", context: { mfeBps: 30, maeBps: -110, heldMs: 120_000 } }),
    result("AUTO:SELL:A:2", "0001", T + 121_000),
    command("AUTO:BUY:B:3", "BUY", "B", T + 300_000, { reason: "ENTRY_SIGNAL", context: { candidate: { type: "MOMENTUM" } } }),
    command("AUTO:SELL:B:4", "SELL", "B", T + 900_000, { reason: "TRAILING_STOP", context: { mfeBps: 150, maeBps: -10 } }),
    result("AUTO:SELL:B:4", "0002", T + 901_000),
    { type: "AUTO_ENTRY_GATE", timestamp: T + 10_000, payload: { blocked: [{ symbol: "C", reason: "BELOW_VWAP" }, { symbol: "D", reason: "BELOW_VWAP" }] } },
    { type: "AUTO_ENTRY_GATE", timestamp: T + 20_000, payload: { blocked: [{ symbol: "C", reason: "STOP_TOO_TIGHT" }] } },
  ];
  const trades = [
    { symbol: "A", orderNumber: "0001", closedAt: T + 121_000, grossPnl: -9_000, totalCost: 2_000, netPnl: -11_000 },
    { symbol: "B", orderNumber: "0002", closedAt: T + 901_000, grossPnl: 12_000, totalCost: 2_000, netPnl: 10_000 },
    { symbol: "Z", orderNumber: "9999", closedAt: T - 3 * 86_400_000, grossPnl: 1, totalCost: 1, netPnl: 0 },
  ];
  const report = buildDailyReport({ events, trades, day: "2026-10-07" });
  assert.equal(report.tradeCount, 2, "다른 날 거래는 빠진다");
  assert.equal(report.totals.net, -1_000);
  assert.equal(report.byExitReason.STOP_LOSS.net, -11_000);
  assert.equal(report.byExitReason.STOP_LOSS.avgMaeBps, -110);
  assert.equal(report.byExitReason.TRAILING_STOP.avgMfeBps, 150);
  assert.equal(report.byEntryType.PULLBACK.count, 1);
  assert.equal(report.byEntryType.MOMENTUM.net, 10_000);
  assert.deepEqual(report.entryGate.reasons, { BELOW_VWAP: 2, STOP_TOO_TIGHT: 1 });
  assert.equal(report.entryGate.distinctSymbolReasons, 3);
  assert.equal(report.trades[0].gate.executionStrength, 120);
  assert.equal(kstDay(T), "2026-10-07");
});

test("주문 기록과 연결되지 않는 거래는 UNKNOWN으로 묶는다", () => {
  const report = buildDailyReport({
    events: [],
    trades: [{ symbol: "A", orderNumber: "x", closedAt: T, grossPnl: 0, totalCost: 0, netPnl: 0 }],
    day: "2026-10-07",
  });
  assert.equal(report.byExitReason.UNKNOWN.count, 1);
  assert.equal(report.byEntryType.UNKNOWN.count, 1);
});
