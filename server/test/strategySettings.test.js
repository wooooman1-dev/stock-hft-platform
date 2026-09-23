import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_STRATEGY_SETTINGS,
  normalizeStrategySettings,
  StrategySettingsError,
} from "../domain/strategySettings.js";
import { StrategySettingsStore } from "../domain/strategySettingsStore.js";

function withTemporaryDirectory(callback) {
  const directory = mkdtempSync(join(tmpdir(), "pulsehft-strategy-"));
  try { return callback(directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test("strategy settings merge partial updates with validated current values", () => {
  const current = normalizeStrategySettings({ orderQuantity: 15, cooldownMs: 8_000 });
  const updated = normalizeStrategySettings({ maximumSpreadTicks: 3 }, { base: current });
  assert.deepEqual(updated, {
    ...DEFAULT_STRATEGY_SETTINGS,
    orderQuantity: 15,
    cooldownMs: 8_000,
    maximumSpreadTicks: 3,
  });
});

test("strategy settings reject unknown fields and unsafe ranges", () => {
  assert.throws(
    () => normalizeStrategySettings({ unknown: 1 }),
    (error) => error instanceof StrategySettingsError && error.statusCode === 400,
  );
  assert.throws(() => normalizeStrategySettings({ orderQuantity: 101 }), /1 이상 100 이하/);
  assert.throws(() => normalizeStrategySettings({ cooldownMs: 999 }), /1000 이상/);
  assert.throws(() => normalizeStrategySettings({ maximumSpreadTicks: 0 }), /1 이상/);
  assert.throws(() => normalizeStrategySettings({ stopLossBps: 0 }), /손절률/);
  assert.throws(() => normalizeStrategySettings({ takeProfitBps: 10_001 }), /익절률/);
  assert.throws(() => normalizeStrategySettings({ trailingStopBps: 1.5 }), /트레일링/);
  assert.throws(() => normalizeStrategySettings({ maxHoldingMs: 999 }), /최대 보유시간/);
});

test("strategy settings store persists and restores the exact validated configuration", () => {
  withTemporaryDirectory((directory) => {
    const filePath = join(directory, "strategy-settings.json");
    const store = new StrategySettingsStore(filePath);
    assert.deepEqual(store.load(), DEFAULT_STRATEGY_SETTINGS);

    const saved = store.save({
      ...DEFAULT_STRATEGY_SETTINGS,
      entryMinimumConfidence: 61,
      exitMinimumConfidence: 57,
      maximumSpreadTicks: 4,
      orderQuantity: 25,
      cooldownMs: 12_000,
      stopLossBps: 125,
      takeProfitBps: 250,
      trailingStopBps: 75,
      maxHoldingMs: 30_000,
    });
    assert.deepEqual(store.load(), saved);
    const payload = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(payload.orderQuantity, 25);
    assert.equal(payload.stopLossBps, 125);
    assert.equal(payload.maxHoldingMs, 30_000);
  });
});

test("old persisted settings migrate risk exits to disabled without changing old values", () => {
  withTemporaryDirectory((directory) => {
    const filePath = join(directory, "strategy-settings.json");
    writeFileSync(filePath, JSON.stringify({
      schemaVersion: 1,
      entryMinimumConfidence: 61,
      exitMinimumConfidence: 55,
      maximumSpreadTicks: 3,
      orderQuantity: 7,
      cooldownMs: 10_000,
    }), "utf8");
    const restored = new StrategySettingsStore(filePath).load();
    assert.deepEqual(restored, {
      ...DEFAULT_STRATEGY_SETTINGS,
      entryMinimumConfidence: 61,
      exitMinimumConfidence: 55,
      maximumSpreadTicks: 3,
      orderQuantity: 7,
      cooldownMs: 10_000,
    });
  });
});

test("strategy settings store does not silently replace a corrupt file", () => {
  withTemporaryDirectory((directory) => {
    const filePath = join(directory, "strategy-settings.json");
    writeFileSync(filePath, "{broken", "utf8");
    const store = new StrategySettingsStore(filePath);
    assert.throws(
      () => store.load(),
      (error) => error.code === "STRATEGY_SETTINGS_READ_FAILED",
    );
  });
});

test("reset writes the documented defaults", () => {
  withTemporaryDirectory((directory) => {
    const store = new StrategySettingsStore(join(directory, "strategy-settings.json"));
    store.save({
      ...DEFAULT_STRATEGY_SETTINGS,
      orderQuantity: 40,
      stopLossBps: 100,
      maxHoldingMs: 60_000,
    });
    assert.deepEqual(store.reset(), DEFAULT_STRATEGY_SETTINGS);
    assert.deepEqual(store.load(), DEFAULT_STRATEGY_SETTINGS);
  });
});

test("every save appends a version to the append-only history with the previous and next settings", () => {
  withTemporaryDirectory((directory) => {
    let clock = 1_000;
    const store = new StrategySettingsStore(join(directory, "strategy-settings.json"), { now: () => clock });
    assert.deepEqual(store.history(), []);

    clock = 2_000;
    store.save({ ...DEFAULT_STRATEGY_SETTINGS, orderQuantity: 20 });
    clock = 3_000;
    store.save({ ...DEFAULT_STRATEGY_SETTINGS, orderQuantity: 20, cooldownMs: 9_000 });

    const history = store.history();
    assert.equal(history.length, 2);
    assert.equal(history[0].version, 1);
    assert.equal(history[0].timestamp, 2_000);
    assert.deepEqual(history[0].previous, DEFAULT_STRATEGY_SETTINGS);
    assert.equal(history[0].next.orderQuantity, 20);
    assert.equal(history[1].version, 2);
    assert.equal(history[1].timestamp, 3_000);
    assert.equal(history[1].previous.orderQuantity, 20);
    assert.equal(history[1].next.cooldownMs, 9_000);
  });
});

test("restoring a prior version re-applies it as a new version instead of rewriting history", () => {
  withTemporaryDirectory((directory) => {
    const store = new StrategySettingsStore(join(directory, "strategy-settings.json"));
    store.save({ ...DEFAULT_STRATEGY_SETTINGS, orderQuantity: 20 });
    store.save({ ...DEFAULT_STRATEGY_SETTINGS, orderQuantity: 30 });

    const restored = store.restore(1);
    assert.equal(restored.orderQuantity, 20);
    assert.equal(store.load().orderQuantity, 20);

    const history = store.history();
    assert.equal(history.length, 3);
    assert.equal(history[2].version, 3);
    assert.equal(history[2].previous.orderQuantity, 30);
    assert.equal(history[2].next.orderQuantity, 20);
  });
});

test("restoring an unknown version is rejected", () => {
  withTemporaryDirectory((directory) => {
    const store = new StrategySettingsStore(join(directory, "strategy-settings.json"));
    store.save({ ...DEFAULT_STRATEGY_SETTINGS, orderQuantity: 20 });
    assert.throws(
      () => store.restore(99),
      (error) => error.code === "STRATEGY_SETTINGS_VERSION_NOT_FOUND",
    );
  });
});

test("a corrupt history file is never silently skipped", () => {
  withTemporaryDirectory((directory) => {
    const filePath = join(directory, "strategy-settings.json");
    const store = new StrategySettingsStore(filePath);
    store.save({ ...DEFAULT_STRATEGY_SETTINGS, orderQuantity: 20 });
    writeFileSync(`${filePath}.history.jsonl`, "not json\n", "utf8");
    assert.throws(
      () => store.history(),
      (error) => error.code === "STRATEGY_SETTINGS_HISTORY_CORRUPT",
    );
  });
});
