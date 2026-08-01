import assert from "node:assert/strict";
import test from "node:test";
import {
  describeAutoStrategy,
  describeRiskExitSettings,
  draftToPayload,
  settingsToDraft,
  setTextContentIfChanged,
} from "../../public/strategySettingsPanel.js";

const settings = {
  schemaVersion: 1,
  entryMinimumConfidence: 61,
  exitMinimumConfidence: 57,
  maximumSpreadTicks: 3,
  orderQuantity: 25,
  cooldownMs: 12_000,
  stopLossBps: 125,
  takeProfitBps: null,
  trailingStopBps: 75,
  maxHoldingMs: 30_000,
};

test("strategy settings panel converts persisted units to editable values and back", () => {
  const draft = settingsToDraft(settings);
  assert.equal(draft.cooldownSeconds, "12");
  assert.equal(draft.stopLossPercent, "1.25");
  assert.equal(draft.takeProfitPercent, "");
  assert.equal(draft.trailingStopPercent, "0.75");
  assert.equal(draft.maxHoldingSeconds, "30");
  assert.deepEqual(draftToPayload(draft), {
    entryMinimumConfidence: 61,
    exitMinimumConfidence: 57,
    maximumSpreadTicks: 3,
    orderQuantity: 25,
    cooldownMs: 12_000,
    stopLossBps: 125,
    takeProfitBps: null,
    trailingStopBps: 75,
    maxHoldingMs: 30_000,
  });
});

test("blank risk exit fields remain disabled", () => {
  const draft = settingsToDraft({
    ...settings,
    stopLossBps: null,
    takeProfitBps: null,
    trailingStopBps: null,
    maxHoldingMs: null,
  });
  assert.equal(draft.stopLossPercent, "");
  assert.equal(draft.takeProfitPercent, "");
  assert.equal(draft.trailingStopPercent, "");
  assert.equal(draft.maxHoldingSeconds, "");
  const payload = draftToPayload(draft);
  assert.equal(payload.stopLossBps, null);
  assert.equal(payload.takeProfitBps, null);
  assert.equal(payload.trailingStopBps, null);
  assert.equal(payload.maxHoldingMs, null);
});

test("strategy settings panel rejects incomplete and out-of-range values", () => {
  assert.throws(() => draftToPayload({
    ...settingsToDraft(settings),
    orderQuantity: "",
  }), /진입 수량/);
  assert.throws(() => draftToPayload({
    ...settingsToDraft(settings),
    cooldownSeconds: "601",
  }), /재진입 대기시간/);
  assert.throws(() => draftToPayload({
    ...settingsToDraft(settings),
    stopLossPercent: "0",
  }), /손절률/);
  assert.throws(() => draftToPayload({
    ...settingsToDraft(settings),
    takeProfitPercent: "1.001",
  }), /익절률/);
  assert.throws(() => draftToPayload({
    ...settingsToDraft(settings),
    maxHoldingSeconds: "0",
  }), /최대 보유시간/);
});

test("auto strategy and risk descriptions reflect the effective saved values", () => {
  assert.equal(
    describeAutoStrategy(settings),
    "진입 61% · 청산 57% · 최대 3틱 · 25주 · 12초 대기 · 위험청산 3개",
  );
  assert.equal(
    describeRiskExitSettings(settings),
    "손절 1.25% · 익절 OFF · 트레일링 0.75% · 최대보유 30초",
  );
});

test("strategy description does not mutate DOM when text is already current", () => {
  let writes = 0;
  const element = {
    value: describeAutoStrategy(settings),
    get textContent() { return this.value; },
    set textContent(next) {
      writes += 1;
      this.value = next;
    },
  };

  assert.equal(setTextContentIfChanged(element, describeAutoStrategy(settings)), false);
  assert.equal(writes, 0);
  assert.equal(setTextContentIfChanged(element, "변경된 설명"), true);
  assert.equal(writes, 1);
});
