import assert from "node:assert/strict";
import test from "node:test";
import { MarketRuntime } from "../domain/runtime.js";

function setRuntimeMarket(runtime, lastPrice, timestamp) {
  runtime.snapshotValue.lastPrice = lastPrice;
  runtime.snapshotValue.timestamp = timestamp;
  runtime.snapshotValue.metrics = { signal: "HOLD", confidence: 0, spreadTicks: 1 };
  runtime.snapshotValue.book = {
    bids: [{ price: lastPrice, size: 1_000 }],
    asks: [{ price: lastPrice + runtime.simulator.tickSize, size: 1_000 }],
  };
  runtime.snapshotValue.account = runtime.trader.snapshot(lastPrice);
  runtime.syncPositionRisk(lastPrice, timestamp);
}

test("runtime initialization uses the injected clock for the first market snapshot", () => {
  const runtime = new MarketRuntime("005930", "삼성전자", 70_000, { now: () => 12_345 });
  assert.equal(runtime.snapshot().timestamp, 12_345);
  runtime.stop();
});

test("runtime tracks entry time and executes a stop loss through the paper order engine", () => {
  let now = 10_000;
  const runtime = new MarketRuntime("005930", "삼성전자", 70_000, { now: () => now });
  const buy = runtime.submitOrder({
    side: "BUY",
    type: "MARKET",
    quantity: 10,
    clientOrderId: "risk-runtime-entry",
    timestamp: now,
  });
  assert.equal(buy.status, "FILLED");

  let snapshot = runtime.snapshot();
  assert.equal(snapshot.strategy.riskState.openedAt, now);
  assert.equal(snapshot.strategy.riskState.quantity, 10);
  const averagePrice = snapshot.account.position.averagePrice;

  runtime.setStrategySettings({ stopLossBps: 100 });
  runtime.setAutoPaperTrading(true);
  now += 1_000;
  const stopPrice = Math.floor((averagePrice * 0.98) / runtime.simulator.tickSize) * runtime.simulator.tickSize;
  setRuntimeMarket(runtime, stopPrice, now);
  runtime.maybeRunStrategy(now);

  snapshot = runtime.snapshot();
  assert.equal(snapshot.account.position.quantity, 0);
  assert.deepEqual(snapshot.strategy.riskState, {
    quantity: 0,
    openedAt: null,
    peakPrice: null,
    belowPeakSince: null,
  });
  const exitOrder = snapshot.account.orders[0];
  assert.equal(exitOrder.side, "SELL");
  assert.equal(exitOrder.source, "STRATEGY");
  assert.match(exitOrder.clientOrderId, /stop-loss/);
  assert.equal(exitOrder.status, "FILLED");
  runtime.stop();
});

test("protective exit cancels every resting order before flattening the full position", () => {
  let now = 30_000;
  const runtime = new MarketRuntime("005930", "삼성전자", 70_000, { now: () => now });
  runtime.submitOrder({
    side: "BUY",
    type: "MARKET",
    quantity: 10,
    clientOrderId: "risk-reservation-entry",
    timestamp: now,
  });

  let snapshot = runtime.snapshot();
  const bestBid = snapshot.book.bids[0].price;
  const openSell = runtime.submitOrder({
    side: "SELL",
    type: "LIMIT",
    quantity: 4,
    limitPrice: bestBid + runtime.simulator.tickSize * 10,
    clientOrderId: "risk-open-sell",
    timestamp: now + 1,
  });
  const openBuy = runtime.submitOrder({
    side: "BUY",
    type: "LIMIT",
    quantity: 2,
    limitPrice: bestBid - runtime.simulator.tickSize,
    clientOrderId: "risk-open-buy",
    timestamp: now + 2,
  });
  assert.equal(openSell.status, "ACCEPTED");
  assert.equal(openBuy.status, "ACCEPTED");
  snapshot = runtime.snapshot();
  assert.equal(snapshot.account.openOrderCount, 2);
  assert.equal(snapshot.account.sellableQuantity, 6);

  const averagePrice = snapshot.account.position.averagePrice;
  runtime.setStrategySettings({ stopLossBps: 1 });
  runtime.setAutoPaperTrading(true);
  now += 1_000;
  setRuntimeMarket(runtime, averagePrice - runtime.simulator.tickSize, now);
  runtime.maybeRunStrategy(now);

  snapshot = runtime.snapshot();
  assert.equal(snapshot.account.position.quantity, 0);
  assert.equal(snapshot.account.openOrderCount, 0);
  const ordersByClientId = Object.fromEntries(
    snapshot.account.orders.map((order) => [order.clientOrderId, order]),
  );
  assert.equal(ordersByClientId["risk-open-sell"].status, "CANCELLED");
  assert.equal(ordersByClientId["risk-open-buy"].status, "CANCELLED");
  assert.match(ordersByClientId["risk-open-sell"].reason, /전략 청산/);
  assert.equal(snapshot.account.orders[0].source, "STRATEGY");
  assert.match(snapshot.account.orders[0].clientOrderId, /stop-loss/);
  runtime.stop();
});

test("runtime does not execute protective exits while auto strategy is off", () => {
  let now = 20_000;
  const runtime = new MarketRuntime("005930", "삼성전자", 70_000, { now: () => now });
  runtime.submitOrder({
    side: "BUY",
    type: "MARKET",
    quantity: 2,
    clientOrderId: "risk-runtime-disabled",
    timestamp: now,
  });
  const averagePrice = runtime.snapshot().account.position.averagePrice;
  runtime.setStrategySettings({ stopLossBps: 1 });
  now += 1_000;
  setRuntimeMarket(runtime, Math.floor(averagePrice * 0.9), now);
  runtime.maybeRunStrategy(now);
  assert.equal(runtime.snapshot().account.position.quantity, 2);
  runtime.stop();
});
