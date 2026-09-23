import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaperAutoTradingConfigStore } from "../domain/paperAutoTradingConfigStore.js";

// 2026-09-17: 화면에서 바꾼 모의계좌 자동매매 설정·안전 한도가 저장되지 않아
// 재시작하면 .env 기본값으로 되돌아갔다. 이 저장소가 그 재시작 생존을 보장한다.

test("returns null before anything has been saved", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pulsehft-auto-trading-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new PaperAutoTradingConfigStore(join(dir, "config.json"));
  assert.equal(store.load(), null);
});

test("persists settings and limits and survives a fresh store instance (restart)", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pulsehft-auto-trading-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = join(dir, "config.json");

  const first = new PaperAutoTradingConfigStore(filePath);
  first.save({ settings: { cooldownMs: 12345 } });
  first.save({ limits: { maxDailyOrders: 7 } });

  const restarted = new PaperAutoTradingConfigStore(filePath);
  const loaded = restarted.load();
  assert.equal(loaded.settings.cooldownMs, 12345);
  assert.equal(loaded.limits.maxDailyOrders, 7);
});

test("saving one of settings/limits never erases the other", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pulsehft-auto-trading-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new PaperAutoTradingConfigStore(join(dir, "config.json"));

  store.save({ settings: { cooldownMs: 1 }, limits: { maxDailyOrders: 1 } });
  store.save({ settings: { cooldownMs: 2 } });

  const loaded = store.load();
  assert.equal(loaded.settings.cooldownMs, 2);
  assert.equal(loaded.limits.maxDailyOrders, 1);
});

test("persists performanceResetAt without erasing settings/limits, and clearing it back to null sticks", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pulsehft-auto-trading-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new PaperAutoTradingConfigStore(join(dir, "config.json"));

  store.save({ settings: { cooldownMs: 1 }, limits: { maxDailyOrders: 1 } });
  store.save({ performanceResetAt: 1_700_000_000_000 });

  const loaded = store.load();
  assert.equal(loaded.settings.cooldownMs, 1);
  assert.equal(loaded.limits.maxDailyOrders, 1);
  assert.equal(loaded.performanceResetAt, 1_700_000_000_000);

  store.save({ performanceResetAt: null });
  assert.equal(store.load().performanceResetAt, null);
});

test("a corrupt config file is reported, not silently ignored", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pulsehft-auto-trading-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = join(dir, "config.json");
  const store = new PaperAutoTradingConfigStore(filePath);
  store.save({ settings: { cooldownMs: 1 } });

  writeFileSync(filePath, "not json", "utf8");
  assert.throws(() => store.load(), (error) => error.code === "PAPER_AUTO_TRADING_CONFIG_READ_FAILED");
});
