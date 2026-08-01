import assert from "node:assert/strict";
import test from "node:test";
import { MarketRuntime } from "../domain/runtime.js";

test("runtime accepts structured market orders and protects duplicate clientOrderId", () => {
  let now = 10_000;
  const runtime = new MarketRuntime("005930", "삼성전자", 70_000, { now: () => now });
  const first = runtime.submitOrder({
    side: "BUY",
    type: "MARKET",
    quantity: 2,
    clientOrderId: "runtime-market-1",
    timestamp: now,
  });
  const replay = runtime.submitOrder({
    side: "BUY",
    type: "MARKET",
    quantity: 2,
    clientOrderId: "runtime-market-1",
    timestamp: now,
  });

  assert.equal(first.status, "FILLED");
  assert.equal(replay.id, first.id);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(runtime.snapshot().account.position.quantity, 2);
  runtime.stop();
});

test("runtime exposes and cancels an open limit order", () => {
  let now = 20_000;
  const runtime = new MarketRuntime("005930", "삼성전자", 70_000, { now: () => now });
  const bestBid = runtime.snapshot().book.bids[0].price;
  const order = runtime.submitOrder({
    side: "BUY",
    type: "LIMIT",
    quantity: 3,
    limitPrice: bestBid,
    clientOrderId: "runtime-limit-1",
    timestamp: now,
  });

  assert.equal(order.status, "ACCEPTED");
  assert.equal(order.isOpen, true);
  now += 100;
  const cancelled = runtime.cancelOrder(order.id);
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(runtime.snapshot().account.openOrderCount, 0);
  runtime.stop();
});
