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
  assert.match(indexSource, /recommendationTabs\.js\?v=6/);
});

test("recommendation workspace can be isolated without loading the tab adapter", () => {
  assert.match(indexSource, /noRecommendationTabs/);
  assert.match(indexSource, /await import\("\/recommendationTabs\.js\?v=6"\)/);
});

test("workspace converts the recommendation modal into persistent tabs", () => {
  assert.match(tabsSource, /data-recommendation-tab="main"/);
  assert.match(tabsSource, /data-recommendation-tab="recommendations"/);
  assert.match(tabsSource, /data-recommendation-tab="kis-paper"/);
  assert.match(tabsSource, /position:static!important/);
  assert.match(tabsSource, /panel\.removeAttribute\("aria-modal"\)/);
  assert.match(tabsSource, /openRecommendationPanel\(\)/);
  assert.match(tabsSource, /setInterval\(\(\) => void refreshTabStatus\(\), 15_000\)/);
});

test("workspace tabs live outside the snapshot-rendered app tree", () => {
  assert.match(appSource, /app\.innerHTML\s*=/);
  assert.match(tabsSource, /tabsPortal\.className = "recommendation-tabs-portal"/);
  assert.match(tabsSource, /document\.body\.append\(tabsPortal\)/);
  assert.match(tabsSource, /document\.body\.append\(kisPaperWorkspace\)/);
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
  assert.doesNotMatch(tabsSource, /ensureLegacyOpen/);
});

test("workspace preserves view state and returns selected symbols to main analysis", () => {
  assert.match(tabsSource, /pulsehft\.activeWorkspaceView/);
  assert.match(tabsSource, /pulsehft\.recommendationFilter/);
  assert.match(tabsSource, /pulsehft\.kisPaperCommands/);
  assert.match(tabsSource, /tableScrollLeft/);
  assert.match(tabsSource, /tableScrollTop/);
  assert.match(tabsSource, /event\.stopImmediatePropagation\(\)/);
  assert.match(tabsSource, /setActiveView\(VIEW_MAIN\)/);
  assert.match(tabsSource, /let activeView = VIEW_MAIN/);
  assert.match(tabsSource, /pendingInitialView/);
  assert.match(tabsSource, /isWorkspaceReady\(\)/);
  assert.match(tabsSource, /#app\.app-shell> :not\(\.topbar\)/);
  assert.doesNotMatch(tabsSource, /#app> :not\(\.topbar\)/);
});

test("KIS paper workspace is isolated from internal paper trading", () => {
  assert.match(tabsSource, /VIEW_KIS_PAPER = "KIS_PAPER"/);
  assert.match(tabsSource, /KIS PROD READ-ONLY 시세/);
  assert.match(tabsSource, /KIS PAPER ACCOUNT/);
  assert.match(tabsSource, /자동전략과 매수추천 자동주문은 연결되어 있지 않습니다/);
  assert.match(tabsSource, /fetchJson\("\/api\/kis\/paper\/status"\)/);
  assert.match(tabsSource, /fetchJson\("\/api\/kis\/paper\/balance"\)/);
  assert.match(tabsSource, /fetchJson\(`\/api\/kis\/quote\?symbol=/);
  assert.match(tabsSource, /fetchJson\("\/api\/kis\/paper\/orders"/);
  assert.doesNotMatch(tabsSource, /fetchJson\("\/api\/paper\/orders"/);
});

test("KIS paper orders require confirmation and distinguish acceptance from execution", () => {
  assert.match(tabsSource, /window\.confirm\(/);
  assert.match(tabsSource, /ACCEPTED는 증권사 주문 접수이며 실제 체결 완료를 의미하지 않습니다/);
  assert.match(tabsSource, /createKisClientOrderId\(side\)/);
  assert.match(tabsSource, /referencePrice/);
  assert.match(tabsSource, /result\.status === "UNKNOWN_RESULT"/);
  assert.match(tabsSource, /result\.status === "REJECTED"/);
});
