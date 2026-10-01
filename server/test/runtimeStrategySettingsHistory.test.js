import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MarketRuntime } from "../domain/runtime.js";
import { StrategySettingsStore } from "../domain/strategySettingsStore.js";

function withTemporaryDirectory(callback) {
  const directory = mkdtempSync(join(tmpdir(), "pulsehft-runtime-strategy-"));
  try { return callback(directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test("runtime with no strategy settings store reports empty history and refuses to restore", () => {
  const runtime = new MarketRuntime("005930", "삼성전자", 70_000, { now: () => 1_000 });
  assert.deepEqual(runtime.getStrategySettingsHistory(), []);
  assert.throws(
    () => runtime.restoreStrategySettings(1),
    (error) => error.code === "STRATEGY_SETTINGS_STORE_UNAVAILABLE",
  );
});

test("runtime persists each strategy settings change to history and can restore a prior version", () => {
  withTemporaryDirectory((directory) => {
    const strategySettingsStore = new StrategySettingsStore(join(directory, "strategy-settings.json"));
    const runtime = new MarketRuntime("005930", "삼성전자", 70_000, { now: () => 1_000, strategySettingsStore });

    runtime.setStrategySettings({ orderQuantity: 20 });
    runtime.setStrategySettings({ orderQuantity: 30 });
    assert.equal(runtime.getStrategySettings().orderQuantity, 30);

    const history = runtime.getStrategySettingsHistory();
    assert.equal(history.length, 2);

    const restored = runtime.restoreStrategySettings(history[0].version);
    assert.equal(restored.orderQuantity, 20);
    assert.equal(runtime.getStrategySettings().orderQuantity, 20);
    assert.equal(runtime.getStrategySettingsHistory().length, 3);
  });
});
