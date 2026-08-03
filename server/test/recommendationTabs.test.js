import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const tabsSource = readFileSync(new URL("../../public/recommendationTabs.js", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../public/app.js", import.meta.url), "utf8");

test("recommendation workspace loads the tab adapter after the existing panel", () => {
  const panelIndex = indexSource.indexOf('/recommendationPanel.js');
  const tabsIndex = indexSource.indexOf('/recommendationTabs.js');
  assert.ok(panelIndex >= 0);
  assert.ok(tabsIndex > panelIndex);
  assert.match(indexSource, /recommendationTabs\.js\?v=7/);
});

test("recommendation workspace can be isolated without loading the tab adapter", () => {
  assert.match(indexSource, /noRecommendationTabs/);
  assert.match(indexSource, /await import\("\/recommendationTabs\.js\?v=7"\)/);
});

test("workspace keeps only main analysis and recommendation tabs", () => {
  assert.match(tabsSource, /data-recommendation-tab="main"/);
  assert.match(tabsSource, /data-recommendation-tab="recommendations"/);
  assert.doesNotMatch(tabsSource, /data-recommendation-tab="kis-paper"/);
  assert.doesNotMatch(tabsSource, /kis-paper-workspace/);
  assert.match(tabsSource, /position:static!important/);
  assert.match(tabsSource, /panel\.removeAttribute\("aria-modal"\)/);
  assert.match(tabsSource, /openRecommendationPanel\(\)/);
});

test("workspace tabs live outside the snapshot-rendered app tree", () => {
  assert.match(appSource, /app\.innerHTML\s*=/);
  assert.match(tabsSource, /tabsPortal\.className = "recommendation-tabs-portal"/);
  assert.match(tabsSource, /document\.body\.append\(tabsPortal\)/);
  assert.match(tabsSource, /tabsPortal\.querySelectorAll\("\[data-recommendation-tab\]"\)/);
  assert.doesNotMatch(tabsSource, /topStatus\.insertBefore\(tabs/);
  assert.match(tabsSource, /positionTabs\(topStatus\)/);
});

test("workspace observers cannot observe their own tab mutations", () => {
  assert.match(
    tabsSource,
    /new MutationObserver\(scheduleEnsureTabs\)\.observe\(app, \{ childList: true \}\)/,
  );
  assert.doesNotMatch(
    tabsSource,
    /observe\(app, \{ childList: true, subtree: true \}\)/,
  );
  assert.match(tabsSource, /panelObserver\.observe\(panel, \{ childList: true \}\)/);
});

test("main dashboard uses KIS values and KIS paper order APIs", () => {
  assert.match(appSource, /KIS PROD READ-ONLY/);
  assert.match(appSource, /KIS PAPER ACCOUNT/);
  assert.match(appSource, /\/api\/kis\/paper\/orders/);
  assert.match(appSource, /\/api\/kis\/paper\/orders\/cancel/);
  assert.match(appSource, /\/api\/kis\/main\/refresh/);
  assert.match(appSource, /window\.confirm\(/);
  assert.match(appSource, /ACCEPTED는 증권사 주문 접수/);
  assert.doesNotMatch(appSource, /request\("\/api\/paper\/orders/);
  assert.doesNotMatch(appSource, /data-action="auto"/);
});
