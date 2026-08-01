import assert from "node:assert/strict";
import test from "node:test";
import { MarketRuntime } from "../domain/runtime.js";
import { applyVerificationMarketTick } from "../domain/verificationMarket.js";

test("verification market tick pauses the random timer until restart", () => {
  const runtime = new MarketRuntime("005930", "삼성전자", 70_000, { now: () => 10_000 });
  runtime.start();
  assert.notEqual(runtime.timer, null);

  const snapshot = applyVerificationMarketTick(runtime, {
    lastPrice: 69_000,
    timestamp: 11_000,
  });

  assert.equal(runtime.timer, null);
  assert.equal(snapshot.system.verificationMode, true);
  assert.equal(snapshot.system.marketTimerPaused, true);
  assert.equal(snapshot.lastPrice, 69_000);
  runtime.stop();
});
