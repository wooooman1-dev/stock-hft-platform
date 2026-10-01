import assert from "node:assert/strict";
import test from "node:test";
import { MarketRuntime, StrategyApprovalError } from "../domain/runtime.js";

function setRuntimeMarket(runtime, lastPrice, timestamp, metrics = { signal: "HOLD", confidence: 0, spreadTicks: 1 }) {
  runtime.snapshotValue.lastPrice = lastPrice;
  runtime.snapshotValue.timestamp = timestamp;
  runtime.snapshotValue.metrics = metrics;
  runtime.snapshotValue.book = {
    bids: [{ price: lastPrice, size: 1_000 }],
    asks: [{ price: lastPrice + runtime.simulator.tickSize, size: 1_000 }],
  };
  runtime.snapshotValue.account = runtime.trader.snapshot(lastPrice);
  runtime.syncPositionRisk(lastPrice, timestamp);
}

const BUY_METRICS = { signal: "BUY", confidence: 90, spreadTicks: 1 };

test("a BUY signal in SEMI_AUTO mode is queued for approval instead of submitted immediately", () => {
  let now = 10_000;
  const runtime = new MarketRuntime("005930", "삼성전자", 70_000, { now: () => now });
  runtime.setStrategySettings({ approvalMode: "SEMI_AUTO" });
  runtime.setAutoPaperTrading(true);

  setRuntimeMarket(runtime, 70_000, now, BUY_METRICS);
  runtime.maybeRunStrategy(now);

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.account.position.quantity, 0);
  assert.equal(snapshot.account.orders.length, 0);
  const pending = runtime.getPendingApprovals();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "PENDING");
  assert.equal(pending[0].side, "BUY");
  assert.equal(pending[0].quantity, snapshot.strategy.settings.orderQuantity);
  runtime.stop();
});

test("approving a pending request submits the order against current market data", () => {
  let now = 10_000;
  const runtime = new MarketRuntime("005930", "삼성전자", 70_000, { now: () => now });
  runtime.setStrategySettings({ approvalMode: "SEMI_AUTO" });
  runtime.setAutoPaperTrading(true);
  setRuntimeMarket(runtime, 70_000, now, BUY_METRICS);
  runtime.maybeRunStrategy(now);
  const [pending] = runtime.getPendingApprovals();

  now += 500;
  const order = runtime.approveOrder(pending.id);
  assert.equal(order.status, "FILLED");
  assert.equal(order.side, "BUY");

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.account.position.quantity, order.filledQuantity);
  const [resolved] = runtime.getPendingApprovals();
  assert.equal(resolved.status, "APPROVED");
  assert.equal(resolved.resolvedAt, now);
  runtime.stop();
});

test("rejecting a pending request never submits an order", () => {
  let now = 10_000;
  const runtime = new MarketRuntime("005930", "삼성전자", 70_000, { now: () => now });
  runtime.setStrategySettings({ approvalMode: "SEMI_AUTO" });
  runtime.setAutoPaperTrading(true);
  setRuntimeMarket(runtime, 70_000, now, BUY_METRICS);
  runtime.maybeRunStrategy(now);
  const [pending] = runtime.getPendingApprovals();

  const rejected = runtime.rejectOrder(pending.id);
  assert.equal(rejected.status, "REJECTED");
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.account.orders.length, 0);
  assert.equal(snapshot.account.position.quantity, 0);
  runtime.stop();
});

test("an unresolved pending approval expires after approvalExpiryMs and unblocks a new request", () => {
  let now = 10_000;
  const runtime = new MarketRuntime("005930", "삼성전자", 70_000, { now: () => now });
  runtime.setStrategySettings({ approvalMode: "SEMI_AUTO", approvalExpiryMs: 3_000 });
  runtime.setAutoPaperTrading(true);
  setRuntimeMarket(runtime, 70_000, now, BUY_METRICS);
  runtime.maybeRunStrategy(now);
  const [firstPending] = runtime.getPendingApprovals();
  assert.equal(firstPending.status, "PENDING");

  now += 4_000;
  setRuntimeMarket(runtime, 70_000, now, BUY_METRICS);
  runtime.maybeRunStrategy(now);

  const pendingAfter = runtime.getPendingApprovals();
  const expired = pendingAfter.find((item) => item.id === firstPending.id);
  assert.equal(expired.status, "EXPIRED");
  const active = pendingAfter.filter((item) => item.status === "PENDING");
  assert.equal(active.length, 1);
  runtime.stop();
});

test("a second BUY signal does not create a duplicate pending request while one is already open", () => {
  let now = 10_000;
  const runtime = new MarketRuntime("005930", "삼성전자", 70_000, { now: () => now });
  runtime.setStrategySettings({ approvalMode: "SEMI_AUTO" });
  runtime.setAutoPaperTrading(true);
  setRuntimeMarket(runtime, 70_000, now, BUY_METRICS);
  runtime.maybeRunStrategy(now);
  now += 100;
  setRuntimeMarket(runtime, 70_000, now, BUY_METRICS);
  runtime.maybeRunStrategy(now);

  assert.equal(runtime.getPendingApprovals().length, 1);
  runtime.stop();
});

test("protective stop-loss exits execute immediately in SEMI_AUTO mode without going through approval", () => {
  let now = 10_000;
  const runtime = new MarketRuntime("005930", "삼성전자", 70_000, { now: () => now });
  const buy = runtime.submitOrder({
    side: "BUY", type: "MARKET", quantity: 10, clientOrderId: "semi-auto-entry", timestamp: now,
  });
  assert.equal(buy.status, "FILLED");
  const averagePrice = runtime.snapshot().account.position.averagePrice;

  runtime.setStrategySettings({ stopLossBps: 100, approvalMode: "SEMI_AUTO" });
  runtime.setAutoPaperTrading(true);
  now += 1_000;
  const stopPrice = Math.floor((averagePrice * 0.98) / runtime.simulator.tickSize) * runtime.simulator.tickSize;
  setRuntimeMarket(runtime, stopPrice, now);
  runtime.maybeRunStrategy(now);

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.account.position.quantity, 0);
  assert.equal(runtime.getPendingApprovals().length, 0);
  const exitOrder = snapshot.account.orders[0];
  assert.equal(exitOrder.side, "SELL");
  assert.equal(exitOrder.status, "FILLED");
  runtime.stop();
});

test("approving or rejecting an unknown id is rejected with a clear error", () => {
  const runtime = new MarketRuntime("005930", "삼성전자", 70_000, { now: () => 10_000 });
  assert.throws(() => runtime.approveOrder("does-not-exist"), StrategyApprovalError);
  assert.throws(() => runtime.rejectOrder("does-not-exist"), StrategyApprovalError);
  runtime.stop();
});

test("resolving the same request twice is rejected the second time", () => {
  let now = 10_000;
  const runtime = new MarketRuntime("005930", "삼성전자", 70_000, { now: () => now });
  runtime.setStrategySettings({ approvalMode: "SEMI_AUTO" });
  runtime.setAutoPaperTrading(true);
  setRuntimeMarket(runtime, 70_000, now, BUY_METRICS);
  runtime.maybeRunStrategy(now);
  const [pending] = runtime.getPendingApprovals();

  runtime.approveOrder(pending.id);
  assert.throws(() => runtime.approveOrder(pending.id), StrategyApprovalError);
  assert.throws(() => runtime.rejectOrder(pending.id), StrategyApprovalError);
  runtime.stop();
});
