import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAutoStrategy } from "../domain/strategyPolicy.js";
import { DEFAULT_STRATEGY_SETTINGS } from "../domain/strategySettings.js";

const flatAccount = { position: { quantity: 0 } };

test("entry settings control confidence, spread, quantity, and cooldown", () => {
  const settings = {
    ...DEFAULT_STRATEGY_SETTINGS,
    entryMinimumConfidence: 60,
    maximumSpreadTicks: 1,
    orderQuantity: 17,
    cooldownMs: 10_000,
  };

  assert.equal(evaluateAutoStrategy({
    metrics: { signal: "BUY", confidence: 59, spreadTicks: 1 },
    account: flatAccount,
    settings,
    now: 20_000,
    lastOrderAt: 0,
  }), null);

  assert.equal(evaluateAutoStrategy({
    metrics: { signal: "BUY", confidence: 60, spreadTicks: 2 },
    account: flatAccount,
    settings,
    now: 20_000,
    lastOrderAt: 0,
  }), null);

  assert.equal(evaluateAutoStrategy({
    metrics: { signal: "BUY", confidence: 80, spreadTicks: 1 },
    account: flatAccount,
    settings,
    now: 9_999,
    lastOrderAt: 0,
  }), null);

  assert.deepEqual(evaluateAutoStrategy({
    metrics: { signal: "BUY", confidence: 60, spreadTicks: 1 },
    account: flatAccount,
    settings,
    now: 10_000,
    lastOrderAt: 0,
  }), { side: "BUY", quantity: 17, reason: "ENTRY_SIGNAL" });
});

test("exit settings close the complete open position", () => {
  const settings = { ...DEFAULT_STRATEGY_SETTINGS, exitMinimumConfidence: 70 };
  assert.equal(evaluateAutoStrategy({
    metrics: { signal: "SELL", confidence: 69, spreadTicks: 10 },
    account: { position: { quantity: 23 } },
    settings,
    now: 20_000,
    lastOrderAt: 0,
  }), null);

  assert.deepEqual(evaluateAutoStrategy({
    metrics: { signal: "SELL", confidence: 70, spreadTicks: 10 },
    account: { position: { quantity: 23 } },
    settings,
    now: 20_000,
    lastOrderAt: 0,
  }), { side: "SELL", quantity: 23, reason: "EXIT_SIGNAL" });
});
