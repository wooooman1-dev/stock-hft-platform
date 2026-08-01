import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateAutoStrategy,
  evaluatePositionRiskExit,
} from "../domain/strategyPolicy.js";
import {
  DEFAULT_STRATEGY_SETTINGS,
  normalizeStrategySettings,
  StrategySettingsError,
} from "../domain/strategySettings.js";

const account = ({ quantity = 10, averagePrice = 10_000, sellableQuantity = quantity } = {}) => ({
  position: { quantity, averagePrice },
  sellableQuantity,
});

const riskState = ({ openedAt = 1_000, peakPrice = 10_000 } = {}) => ({
  quantity: 10,
  openedAt,
  peakPrice,
});

test("risk exits are disabled by default and old persisted settings gain OFF fields", () => {
  const migrated = normalizeStrategySettings({
    entryMinimumConfidence: 61,
    exitMinimumConfidence: 55,
    maximumSpreadTicks: 3,
    orderQuantity: 7,
    cooldownMs: 10_000,
  });
  assert.equal(migrated.stopLossBps, null);
  assert.equal(migrated.takeProfitBps, null);
  assert.equal(migrated.trailingStopBps, null);
  assert.equal(migrated.maxHoldingMs, null);
  assert.equal(evaluatePositionRiskExit({
    account: account(),
    settings: migrated,
    now: 999_999,
    lastPrice: 1,
    positionRiskState: riskState({ peakPrice: 20_000 }),
  }), null);
});

test("risk exit settings accept null and reject unsafe boundaries", () => {
  assert.deepEqual(normalizeStrategySettings({
    stopLossBps: 1,
    takeProfitBps: 10_000,
    trailingStopBps: null,
    maxHoldingMs: 1_000,
  }), {
    ...DEFAULT_STRATEGY_SETTINGS,
    stopLossBps: 1,
    takeProfitBps: 10_000,
    trailingStopBps: null,
    maxHoldingMs: 1_000,
  });
  assert.throws(
    () => normalizeStrategySettings({ stopLossBps: 0 }),
    (error) => error instanceof StrategySettingsError && /손절률/.test(error.message),
  );
  assert.throws(() => normalizeStrategySettings({ takeProfitBps: 10_001 }), /익절률/);
  assert.throws(() => normalizeStrategySettings({ trailingStopBps: 1.5 }), /트레일링/);
  assert.throws(() => normalizeStrategySettings({ maxHoldingMs: 999 }), /최대 보유시간/);
});

test("stop loss triggers exactly at the configured loss and uses only sellable shares", () => {
  const intent = evaluatePositionRiskExit({
    account: account({ quantity: 10, averagePrice: 10_000, sellableQuantity: 6 }),
    settings: { ...DEFAULT_STRATEGY_SETTINGS, stopLossBps: 100 },
    now: 2_000,
    lastPrice: 9_900,
    positionRiskState: riskState(),
  });
  assert.equal(intent.side, "SELL");
  assert.equal(intent.quantity, 6);
  assert.equal(intent.reason, "STOP_LOSS");
  assert.ok(intent.diagnostics.returnBps <= -100);
});

test("take profit triggers exactly at the configured gain", () => {
  const intent = evaluatePositionRiskExit({
    account: account(),
    settings: { ...DEFAULT_STRATEGY_SETTINGS, takeProfitBps: 250 },
    now: 2_000,
    lastPrice: 10_250,
    positionRiskState: riskState(),
  });
  assert.equal(intent.reason, "TAKE_PROFIT");
  assert.equal(intent.quantity, 10);
});

test("trailing stop uses peak price rather than average entry price", () => {
  const intent = evaluatePositionRiskExit({
    account: account({ averagePrice: 9_000 }),
    settings: { ...DEFAULT_STRATEGY_SETTINGS, trailingStopBps: 100 },
    now: 2_000,
    lastPrice: 9_900,
    positionRiskState: riskState({ peakPrice: 10_000 }),
  });
  assert.equal(intent.reason, "TRAILING_STOP");
  assert.ok(intent.diagnostics.returnBps > 0);
  assert.ok(intent.diagnostics.drawdownFromPeakBps >= 100);
});

test("maximum holding time triggers at the exact boundary", () => {
  const settings = { ...DEFAULT_STRATEGY_SETTINGS, maxHoldingMs: 5_000 };
  assert.equal(evaluatePositionRiskExit({
    account: account(),
    settings,
    now: 5_999,
    lastPrice: 10_000,
    positionRiskState: riskState({ openedAt: 1_000 }),
  }), null);
  const intent = evaluatePositionRiskExit({
    account: account(),
    settings,
    now: 6_000,
    lastPrice: 10_000,
    positionRiskState: riskState({ openedAt: 1_000 }),
  });
  assert.equal(intent.reason, "MAX_HOLDING_TIME");
  assert.equal(intent.diagnostics.heldMs, 5_000);
});

test("protective exits bypass entry cooldown but still require auto strategy evaluation", () => {
  const intent = evaluateAutoStrategy({
    metrics: { signal: "HOLD", confidence: 0, spreadTicks: 1 },
    account: account(),
    settings: { ...DEFAULT_STRATEGY_SETTINGS, stopLossBps: 100, cooldownMs: 600_000 },
    now: 2_000,
    lastOrderAt: 1_999,
    lastPrice: 9_800,
    positionRiskState: riskState(),
  });
  assert.equal(intent.reason, "STOP_LOSS");
});

test("risk exits do not create an oversell when every share is reserved", () => {
  assert.equal(evaluatePositionRiskExit({
    account: account({ quantity: 10, sellableQuantity: 0 }),
    settings: { ...DEFAULT_STRATEGY_SETTINGS, stopLossBps: 1 },
    now: 2_000,
    lastPrice: 9_000,
    positionRiskState: riskState(),
  }), null);
});

test("signal exits also respect sellable quantity reservations", () => {
  assert.deepEqual(evaluateAutoStrategy({
    metrics: { signal: "SELL", confidence: 80, spreadTicks: 10 },
    account: account({ quantity: 10, sellableQuantity: 4 }),
    settings: { ...DEFAULT_STRATEGY_SETTINGS, exitMinimumConfidence: 70 },
    now: 20_000,
    lastOrderAt: 0,
    lastPrice: 10_000,
    positionRiskState: riskState(),
  }), { side: "SELL", quantity: 4, reason: "EXIT_SIGNAL" });
});
