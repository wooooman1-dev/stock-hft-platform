import assert from "node:assert/strict";
import test from "node:test";
import {
  describeAutoStrategy,
  draftToPayload,
  settingsToDraft,
} from "../../public/strategySettingsPanel.js";

const settings = {
  schemaVersion: 1,
  entryMinimumConfidence: 61,
  exitMinimumConfidence: 57,
  maximumSpreadTicks: 3,
  orderQuantity: 25,
  cooldownMs: 12_000,
};

test("strategy settings panel converts persisted milliseconds to editable seconds and back", () => {
  const draft = settingsToDraft(settings);
  assert.equal(draft.cooldownSeconds, "12");
  assert.deepEqual(draftToPayload(draft), {
    entryMinimumConfidence: 61,
    exitMinimumConfidence: 57,
    maximumSpreadTicks: 3,
    orderQuantity: 25,
    cooldownMs: 12_000,
  });
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
});

test("auto strategy description reflects the effective saved values", () => {
  assert.equal(
    describeAutoStrategy(settings),
    "진입 61% · 청산 57% · 최대 3틱 · 25주 · 12초 대기",
  );
});
