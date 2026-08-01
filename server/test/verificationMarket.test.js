import assert from "node:assert/strict";
import test from "node:test";
import { MarketRuntime } from "../domain/runtime.js";
import {
  applyVerificationMarketTick,
  createVerificationMarketTick,
  isLoopbackAddress,
  isVerificationApiEnabled,
  VerificationMarketError,
} from "../domain/verificationMarket.js";

function createRuntime(now = 10_000) {
  return new MarketRuntime("005930", "삼성전자", 70_000, { now: () => now });
}

function seedPosition(runtime, clientOrderId) {
  const order = runtime.submitOrder({
    side: "BUY",
    type: "MARKET",
    quantity: 3,
    clientOrderId,
  });
  assert.equal(order.status, "FILLED");
  return runtime.snapshot().account.position.averagePrice;
}

test("verification API requires an exact opt-in and a loopback source", () => {
  assert.equal(isVerificationApiEnabled({}), false);
  assert.equal(isVerificationApiEnabled({ PULSEHFT_ENABLE_VERIFICATION_API: "TRUE" }), false);
  assert.equal(isVerificationApiEnabled({ PULSEHFT_ENABLE_VERIFICATION_API: "true" }), true);

  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.0.10"), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test("verification market tick builds validated visible depth", () => {
  const tick = createVerificationMarketTick({
    lastPrice: 69_000,
    depthSize: 500,
    timestamp: 12_345,
  }, {
    tickSize: 100,
    now: () => 99_999,
    candles: [{ time: 1_000, close: 70_000 }],
  });

  assert.equal(tick.timestamp, 12_345);
  assert.equal(tick.lastPrice, 69_000);
  assert.deepEqual(tick.book.bids[0], { price: 68_900, size: 500 });
  assert.deepEqual(tick.book.asks[0], { price: 69_100, size: 500 });
  assert.equal(tick.book.bids.length, 10);
  assert.equal(tick.book.asks.length, 10);
  assert.deepEqual(tick.trades, []);
  assert.deepEqual(tick.candles, [{ time: 1_000, close: 70_000 }]);

  assert.throws(
    () => createVerificationMarketTick({ lastPrice: 69_050 }, { tickSize: 100 }),
    (error) => error instanceof VerificationMarketError && /호가 단위/.test(error.message),
  );
  assert.throws(
    () => createVerificationMarketTick({ lastPrice: 69_000, unknown: true }, { tickSize: 100 }),
    /지원하지 않는/,
  );
  assert.throws(
    () => createVerificationMarketTick({ lastPrice: 69_000, depthSize: 0 }, { tickSize: 100 }),
    /호가 잔량/,
  );
});

test("deterministic verification tick executes stop loss through the full runtime path", () => {
  const runtime = createRuntime();
  const averagePrice = seedPosition(runtime, "verify-stop-entry");
  runtime.setStrategySettings({
    stopLossBps: 100,
    takeProfitBps: null,
    trailingStopBps: null,
    maxHoldingMs: null,
  });
  runtime.setAutoPaperTrading(true);

  const stopPrice = Math.floor((averagePrice * 0.98) / runtime.simulator.tickSize)
    * runtime.simulator.tickSize;
  const snapshot = applyVerificationMarketTick(runtime, {
    lastPrice: stopPrice,
    timestamp: 11_000,
  });

  assert.equal(snapshot.account.position.quantity, 0);
  assert.equal(snapshot.account.orders[0].side, "SELL");
  assert.equal(snapshot.account.orders[0].source, "STRATEGY");
  assert.match(snapshot.account.orders[0].clientOrderId, /strategy-stop-loss/);
  assert.equal(snapshot.account.orders[0].status, "FILLED");
  runtime.stop();
});

test("deterministic verification tick executes take profit through the full runtime path", () => {
  const runtime = createRuntime();
  const averagePrice = seedPosition(runtime, "verify-profit-entry");
  runtime.setStrategySettings({
    stopLossBps: null,
    takeProfitBps: 200,
    trailingStopBps: null,
    maxHoldingMs: null,
  });
  runtime.setAutoPaperTrading(true);

  const profitPrice = Math.ceil((averagePrice * 1.03) / runtime.simulator.tickSize)
    * runtime.simulator.tickSize;
  const snapshot = applyVerificationMarketTick(runtime, {
    lastPrice: profitPrice,
    timestamp: 11_000,
  });

  assert.equal(snapshot.account.position.quantity, 0);
  assert.match(snapshot.account.orders[0].clientOrderId, /strategy-take-profit/);
  assert.equal(snapshot.account.orders[0].status, "FILLED");
  runtime.stop();
});

test("deterministic verification ticks update the peak before executing a trailing stop", () => {
  const runtime = createRuntime();
  const averagePrice = seedPosition(runtime, "verify-trailing-entry");
  runtime.setStrategySettings({
    stopLossBps: null,
    takeProfitBps: null,
    trailingStopBps: 100,
    maxHoldingMs: null,
  });
  runtime.setAutoPaperTrading(true);

  const peakPrice = Math.ceil((averagePrice * 1.03) / runtime.simulator.tickSize)
    * runtime.simulator.tickSize;
  let snapshot = applyVerificationMarketTick(runtime, {
    lastPrice: peakPrice,
    timestamp: 11_000,
  });
  assert.equal(snapshot.account.position.quantity, 3);
  assert.equal(snapshot.strategy.riskState.peakPrice, peakPrice);

  const trailingPrice = Math.floor((peakPrice * 0.98) / runtime.simulator.tickSize)
    * runtime.simulator.tickSize;
  snapshot = applyVerificationMarketTick(runtime, {
    lastPrice: trailingPrice,
    timestamp: 12_000,
  });

  assert.equal(snapshot.account.position.quantity, 0);
  assert.match(snapshot.account.orders[0].clientOrderId, /strategy-trailing-stop/);
  assert.equal(snapshot.account.orders[0].status, "FILLED");
  assert.deepEqual(snapshot.strategy.riskState, {
    quantity: 0,
    openedAt: null,
    peakPrice: null,
  });
  runtime.stop();
});

test("verification tick never bypasses the auto strategy OFF boundary", () => {
  const runtime = createRuntime();
  const averagePrice = seedPosition(runtime, "verify-auto-off-entry");
  runtime.setStrategySettings({ stopLossBps: 1 });

  const stopPrice = Math.floor((averagePrice * 0.9) / runtime.simulator.tickSize)
    * runtime.simulator.tickSize;
  const snapshot = applyVerificationMarketTick(runtime, {
    lastPrice: stopPrice,
    timestamp: 11_000,
  });

  assert.equal(snapshot.system.autoPaperTrading, false);
  assert.equal(snapshot.account.position.quantity, 3);
  assert.equal(snapshot.account.orders[0].clientOrderId, "verify-auto-off-entry");
  runtime.stop();
});
