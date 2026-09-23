import test from "node:test";
import assert from "node:assert/strict";
import { computeFillModelComparison } from "../domain/fillModelComparison.js";

function event(sequence, type, payload, timestamp) {
  return { sequence, type, payload, timestamp };
}

function submitCommand({
  clientOrderId = "paper-1",
  side = "BUY",
  type = "MARKET",
  quantity = 5,
  limitPrice = null,
  tickSize = 100,
  referencePrice = 70_000,
  bids = [{ price: 69_900, size: 10 }],
  asks = [{ price: 70_000, size: 10 }],
  timestamp = 1_000,
} = {}) {
  return event(1, "BROKER_ORDER_COMMAND", {
    commandId: `command-${clientOrderId}`,
    clientOrderId,
    operation: "SUBMIT",
    request: { side, type, symbol: "005930", quantity, limitPrice, exchange: "KRX" },
    orderBookSnapshot: { capturedAt: timestamp, tickSize, referencePrice, bids, asks },
    timestamp,
    day: "2026-08-01",
  }, timestamp);
}

function acceptedResult({ clientOrderId = "paper-1", orderNumber = "0000010100", organizationNumber = "00950", timestamp = 1_100 } = {}) {
  return event(2, "BROKER_ORDER_RESULT", {
    commandId: `command-${clientOrderId}`,
    clientOrderId,
    operation: "SUBMIT",
    status: "ACCEPTED",
    result: { orderNumber, orderOrganizationNumber: organizationNumber },
  }, timestamp);
}

function fillObserved({
  orderNumber = "0000010100",
  organizationNumber = "00950",
  cumulativeExecutedQuantity = 5,
  executedPrice = 70_000,
  timestamp = 1_200,
} = {}) {
  return event(3, "BROKER_FILL_OBSERVED", {
    orderNumber,
    orderOrganizationNumber: organizationNumber,
    symbol: "005930",
    side: "BUY",
    cumulativeExecutedQuantity,
    executedPrice,
    capturedAt: timestamp,
  }, timestamp);
}

test("a market buy that fills identically at the broker and internally has zero delta", () => {
  const events = [
    submitCommand(),
    acceptedResult(),
    fillObserved(),
  ];
  const report = computeFillModelComparison(events, { now: () => 5_000 });
  assert.equal(report.totalSubmittedWithSnapshot, 1);
  assert.equal(report.comparableCount, 1);
  assert.equal(report.averagePriceDeltaBps, 0);
  const [entry] = report.recentComparisons;
  assert.equal(entry.internalFill.filledQuantity, 5);
  assert.equal(entry.internalFill.averagePrice, 70_000);
  assert.equal(entry.brokerFill.filledQuantity, 5);
  assert.equal(entry.brokerFill.averagePrice, 70_000);
  assert.equal(entry.comparable, true);
  assert.equal(entry.priceDeltaBps, 0);
  assert.equal(entry.quantityDelta, 0);
});

test("a worse broker fill price than the captured book produces a negative delta", () => {
  const events = [
    submitCommand({ asks: [{ price: 70_000, size: 5 }] }),
    acceptedResult(),
    fillObserved({ executedPrice: 70_700 }),
  ];
  const report = computeFillModelComparison(events, { now: () => 5_000 });
  const [entry] = report.recentComparisons;
  assert.equal(entry.internalFill.averagePrice, 70_000);
  assert.equal(entry.brokerFill.averagePrice, 70_700);
  assert.ok(entry.priceDeltaBps < 0);
});

test("an order without a broker fill yet is reported but not comparable", () => {
  const events = [submitCommand(), acceptedResult()];
  const report = computeFillModelComparison(events, { now: () => 5_000 });
  assert.equal(report.comparableCount, 0);
  const [entry] = report.recentComparisons;
  assert.equal(entry.brokerFill, null);
  assert.equal(entry.comparable, false);
  assert.equal(entry.note, "KIS 체결 관찰 대기 중입니다.");
});

test("submit commands without an order book snapshot are excluded entirely", () => {
  const events = [
    event(1, "BROKER_ORDER_COMMAND", {
      clientOrderId: "no-snapshot",
      operation: "SUBMIT",
      request: { side: "BUY", type: "MARKET", symbol: "005930", quantity: 1 },
      orderBookSnapshot: null,
      timestamp: 1_000,
    }, 1_000),
  ];
  const report = computeFillModelComparison(events, { now: () => 5_000 });
  assert.equal(report.totalSubmittedWithSnapshot, 0);
  assert.equal(report.recentComparisons.length, 0);
});

test("a limit order matches the internal engine using the same limit price", () => {
  const events = [
    submitCommand({
      type: "LIMIT",
      limitPrice: 70_000,
      quantity: 3,
      asks: [{ price: 70_000, size: 3 }],
    }),
    acceptedResult(),
    fillObserved({ cumulativeExecutedQuantity: 3, executedPrice: 70_000 }),
  ];
  const report = computeFillModelComparison(events, { now: () => 5_000 });
  const [entry] = report.recentComparisons;
  assert.equal(entry.internalFill.status, "FILLED");
  assert.equal(entry.internalFill.filledQuantity, 3);
  assert.equal(entry.comparable, true);
});
