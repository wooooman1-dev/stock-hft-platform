import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const tabsSource = readFileSync(new URL("../../public/recommendationTabs.js", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");

test("recommendation workspace loads the tab adapter after the existing panel", () => {
  const panelIndex = indexSource.indexOf('/recommendationPanel.js');
  const tabsIndex = indexSource.indexOf('/recommendationTabs.js');
  assert.ok(panelIndex >= 0);
  assert.ok(tabsIndex > panelIndex);
});

test("recommendation workspace converts the modal into persistent tabs", () => {
  assert.match(tabsSource, /data-recommendation-tab="main"/);
  assert.match(tabsSource, /data-recommendation-tab="recommendations"/);
  assert.match(tabsSource, /position:static!important/);
  assert.match(tabsSource, /panel\.removeAttribute\("aria-modal"\)/);
  assert.match(tabsSource, /ensureLegacyOpen\(\)/);
  assert.match(tabsSource, /setInterval\(\(\) => void refreshTabStatus\(\), 15_000\)/);
});

test("recommendation tabs preserve view state and return selected symbols to main analysis", () => {
  assert.match(tabsSource, /pulsehft\.activeWorkspaceView/);
  assert.match(tabsSource, /pulsehft\.recommendationFilter/);
  assert.match(tabsSource, /tableScrollLeft/);
  assert.match(tabsSource, /tableScrollTop/);
  assert.match(tabsSource, /event\.stopImmediatePropagation\(\)/);
  assert.match(tabsSource, /setActiveView\(VIEW_MAIN\)/);
  assert.doesNotMatch(tabsSource, /api\/orders/);
});
