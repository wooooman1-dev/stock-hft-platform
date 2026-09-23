const style = document.createElement("style");
style.dataset.pulsehftRecommendationTabs = "true";
style.textContent = String.raw`
.recommendation-trigger{display:none!important}
.recommendation-tabs-portal{position:fixed;z-index:45;left:0;top:0;pointer-events:none}
.recommendation-tabs-portal[hidden]{display:none!important}
.recommendation-tabs-portal .recommendation-back-button{pointer-events:auto}
.recommendation-back-button{display:inline-flex;align-items:center;height:30px;border:1px solid #26384f;border-radius:8px;background:#09111d;color:#9fb0c5;padding:0 12px;font-size:10px;font-weight:800;white-space:nowrap;box-shadow:0 8px 24px rgba(0,0,0,.28)}
.recommendation-back-button:hover{color:#d8f8ff;border-color:#5bd6eb}
body.recommendation-open{overflow:auto!important}
body.recommendation-view-active #app.app-shell> :not(.topbar){display:none!important}
body.recommendation-view-active #app.app-shell{padding-bottom:0}
.recommendation-backdrop{position:static!important;inset:auto!important;z-index:auto!important;width:auto!important;max-width:1880px;margin:0 auto!important;padding:12px 24px 24px!important;background:transparent!important;backdrop-filter:none!important;overflow:visible!important}
body:not(.recommendation-view-active) .recommendation-backdrop{display:none!important}
.recommendation-panel{width:100%!important;max-width:none!important;margin:0!important;box-shadow:0 24px 70px rgba(0,0,0,.38)!important}
.recommendation-close{display:none!important}
`;
document.head.append(style);

// 매수추천 리스트가 기본 화면이고, 리스트에서 종목을 고르면 그 종목의 상세
// 페이지(메인 분석)로 전환된다 — 양방향으로 오가는 탭이 아니라, 상세 페이지에
// 있을 때만 "← 매수추천 목록"으로 돌아가는 단방향 흐름이다(2026-09-17).
const FILTER_KEY = "pulsehft.recommendationFilter";
const VIEW_MAIN = "MAIN";
const VIEW_RECOMMENDATIONS = "RECOMMENDATIONS";
const FILTERS = new Set(["ALL", "PULLBACK", "REVERSAL", "BLOCKED"]);

const app = document.querySelector("#app");
const tabsPortal = document.createElement("div");
tabsPortal.className = "recommendation-tabs-portal";
tabsPortal.hidden = true;
tabsPortal.innerHTML = '<button type="button" class="recommendation-back-button" data-recommendation-back>← 매수추천 목록</button>';
document.body.append(tabsPortal);

// 기본은 항상 매수추천 리스트다 — 이전에 상세를 보고 있었더라도 새로고침하면
// 리스트부터 시작한다(세션 간에 기억하지 않는다).
let pendingInitialView = VIEW_RECOMMENDATIONS;
let activeView = VIEW_MAIN;
let initialViewRestored = false;
let ensureTabsScheduled = false;
let panelOpenTimer = null;
let panelOpenAttempts = 0;
let observedPanel = null;
let observedOverlay = null;
let panelObserver = null;
let mainScrollY = 0;
let recommendationScrollY = 0;
let tableScrollLeft = 0;
let tableScrollTop = 0;
let filterRestored = false;
let selectingSymbol = null;

function getOverlay() {
  return document.querySelector(".recommendation-backdrop");
}

function isWorkspaceReady() {
  return Boolean(app?.classList.contains("app-shell") && app.querySelector(".topbar .top-status"));
}

function isRecommendationPanelOpen() {
  const overlay = getOverlay();
  return Boolean(overlay && !overlay.hidden);
}

function applyViewClass() {
  document.body.classList.toggle(
    "recommendation-view-active",
    isWorkspaceReady() && activeView === VIEW_RECOMMENDATIONS && isRecommendationPanelOpen(),
  );
}

function positionTabs(topStatus) {
  if (activeView !== VIEW_MAIN || !topStatus?.isConnected) {
    tabsPortal.hidden = true;
    return;
  }
  tabsPortal.hidden = false;
  const button = tabsPortal.querySelector(".recommendation-back-button");
  if (!button) return;
  const statusRect = topStatus.getBoundingClientRect();
  const firstStatusItem = [...topStatus.children].find((element) => {
    const computed = window.getComputedStyle(element);
    return computed.display !== "none" && computed.visibility !== "hidden";
  });
  const firstRect = firstStatusItem?.getBoundingClientRect();
  const buttonRect = button.getBoundingClientRect();
  const desiredLeft = (firstRect?.left ?? statusRect.right) - 12 - buttonRect.width;
  const left = Math.max(8, Math.min(desiredLeft, window.innerWidth - buttonRect.width - 8));
  const top = statusRect.top + Math.max(0, (statusRect.height - buttonRect.height) / 2);
  tabsPortal.style.transform = `translate(${Math.round(left)}px,${Math.round(top)}px)`;
}

// 백그라운드 탭에서는 requestAnimationFrame이 아예 호출되지 않는다(autoTradingPanel.js
// 도 같은 이유로 방어 로직이 있다). 이게 없으면, 새로고침 시점에 탭이 백그라운드
// 상태였을 경우 매수추천 리스트가 자동으로 열리는 시점 자체가 영영 안 온다
// (2026-09-18). document.hidden이면 타이머로 대체한다.
function scheduleEnsureTabs() {
  if (ensureTabsScheduled) return;
  ensureTabsScheduled = true;
  if (document.hidden) {
    setTimeout(() => {
      ensureTabsScheduled = false;
      ensureTabs();
    }, 0);
    return;
  }
  let done = false;
  const runOnce = () => {
    if (done) return;
    done = true;
    ensureTabsScheduled = false;
    ensureTabs();
  };
  requestAnimationFrame(runOnce);
  setTimeout(runOnce, 200);
}

function ensureTabs() {
  const topStatus = app?.querySelector(".topbar .top-status");
  if (!topStatus) {
    tabsPortal.hidden = true;
    document.body.classList.remove("recommendation-view-active");
    return;
  }
  positionTabs(topStatus);
  bindPanelObserver();
  if (!initialViewRestored) {
    initialViewRestored = true;
    activeView = pendingInitialView;
    if (activeView === VIEW_RECOMMENDATIONS) schedulePanelOpen();
  }
  applyViewClass();
  positionTabs(topStatus);
}

function bindPanelObserver() {
  const overlay = getOverlay();
  const panel = overlay?.querySelector(".recommendation-panel");
  if (!overlay || !panel) return;
  if (observedOverlay !== overlay) {
    observedOverlay?.removeEventListener("scroll", captureTableScroll, true);
    overlay.addEventListener("scroll", captureTableScroll, true);
    observedOverlay = overlay;
  }
  if (observedPanel === panel) return;
  panelObserver?.disconnect();
  observedPanel = panel;
  panelObserver = new MutationObserver(normalizePanelSemantics);
  panelObserver.observe(panel, { childList: true });
  normalizePanelSemantics();
}

function openRecommendationPanel() {
  if (!isWorkspaceReady()) return false;
  const overlay = getOverlay();
  if (!overlay) return false;
  if (overlay.hidden) {
    const trigger = app?.querySelector(".recommendation-trigger");
    if (!trigger) return false;
    trigger.click();
  }
  bindPanelObserver();
  normalizePanelSemantics();
  applyViewClass();
  return !overlay.hidden;
}

function schedulePanelOpen() {
  clearTimeout(panelOpenTimer);
  panelOpenAttempts = 0;
  const attempt = () => {
    if (activeView !== VIEW_RECOMMENDATIONS) return;
    if (openRecommendationPanel()) {
      panelOpenTimer = null;
      panelOpenAttempts = 0;
      return;
    }
    panelOpenAttempts += 1;
    if (panelOpenAttempts >= 40) {
      activeView = VIEW_MAIN;
      pendingInitialView = VIEW_MAIN;
      applyViewClass();
      const topStatus = app?.querySelector(".topbar .top-status");
      if (topStatus) positionTabs(topStatus);
      return;
    }
    panelOpenTimer = setTimeout(attempt, 50);
  };
  attempt();
}

function setActiveView(nextView, { restoreScroll = true } = {}) {
  const normalized = nextView === VIEW_RECOMMENDATIONS ? VIEW_RECOMMENDATIONS : VIEW_MAIN;
  pendingInitialView = normalized;
  if (!isWorkspaceReady()) {
    activeView = VIEW_MAIN;
    document.body.classList.remove("recommendation-view-active");
    return;
  }
  if (activeView === VIEW_RECOMMENDATIONS) recommendationScrollY = window.scrollY;
  else mainScrollY = window.scrollY;
  activeView = normalized;
  if (activeView === VIEW_RECOMMENDATIONS) schedulePanelOpen();
  else {
    clearTimeout(panelOpenTimer);
    panelOpenTimer = null;
    applyViewClass();
  }
  const topStatus = app?.querySelector(".topbar .top-status");
  if (topStatus) positionTabs(topStatus);
  if (restoreScroll) {
    const targetY = activeView === VIEW_RECOMMENDATIONS ? recommendationScrollY : mainScrollY;
    requestAnimationFrame(() => window.scrollTo(0, targetY));
  }
}

function normalizePanelSemantics() {
  const panel = getOverlay()?.querySelector(".recommendation-panel");
  if (!panel) return;
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "매수추천 리스트");
  panel.removeAttribute("aria-modal");
  restoreTableScroll();
  restoreFilter();
}

function captureTableScroll() {
  const wrap = getOverlay()?.querySelector(".recommendation-table-wrap");
  if (!wrap) return;
  tableScrollLeft = wrap.scrollLeft;
  tableScrollTop = wrap.scrollTop;
}

function restoreTableScroll() {
  const wrap = getOverlay()?.querySelector(".recommendation-table-wrap");
  if (!wrap) return;
  wrap.scrollLeft = tableScrollLeft;
  wrap.scrollTop = tableScrollTop;
}

function restoreFilter() {
  if (filterRestored) return;
  const stored = readStorage(FILTER_KEY);
  if (!FILTERS.has(stored) || stored === "ALL") {
    filterRestored = true;
    return;
  }
  const button = getOverlay()?.querySelector(`[data-recommendation-action="filter"][data-filter="${stored}"]`);
  if (!button) return;
  filterRestored = true;
  button.click();
}

async function selectInstrument(symbol) {
  const response = await fetch("/api/instruments/select", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ symbol }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "종목 전환 실패");
  setActiveView(VIEW_MAIN);
}

function handleClick(event) {
  if (event.target.closest("[data-recommendation-back]")) {
    event.preventDefault();
    setActiveView(VIEW_RECOMMENDATIONS);
    return;
  }
  const actionTarget = event.target.closest("[data-recommendation-action]");
  const action = actionTarget?.dataset.recommendationAction;
  if (action === "filter") {
    const filter = actionTarget.dataset.filter ?? "ALL";
    if (FILTERS.has(filter)) writeStorage(FILTER_KEY, filter);
    return;
  }
  if (action === "close") {
    event.preventDefault();
    event.stopImmediatePropagation();
    setActiveView(VIEW_MAIN);
    return;
  }
  if (action === "select") {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (selectingSymbol) return;
    selectingSymbol = actionTarget.dataset.symbol ?? "";
    actionTarget.disabled = true;
    actionTarget.textContent = "전환 중";
    selectInstrument(selectingSymbol).catch((error) => {
      window.alert(error instanceof Error ? error.message : "종목 전환 실패");
    }).finally(() => {
      selectingSymbol = null;
      actionTarget.disabled = false;
      actionTarget.textContent = "메인에서 보기";
    });
    return;
  }
  if (event.target === getOverlay()) {
    event.preventDefault();
    event.stopImmediatePropagation();
    setActiveView(VIEW_MAIN);
  }
}

function handleKeydown(event) {
  if (event.key === "Escape" && activeView === VIEW_MAIN) {
    event.preventDefault();
    event.stopImmediatePropagation();
    setActiveView(VIEW_RECOMMENDATIONS);
  }
}

function readStorage(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, value); } catch {
    // 저장소가 차단돼도 현재 세션 필터는 유지됩니다.
  }
}

if (app) new MutationObserver(scheduleEnsureTabs).observe(app, { childList: true });
document.addEventListener("click", handleClick, true);
document.addEventListener("keydown", handleKeydown, true);
window.addEventListener("resize", scheduleEnsureTabs);
window.addEventListener("scroll", scheduleEnsureTabs, { passive: true });
document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleEnsureTabs(); });

document.body.classList.remove("recommendation-view-active");
scheduleEnsureTabs();
window.addEventListener("beforeunload", () => {
  clearTimeout(panelOpenTimer);
  panelObserver?.disconnect();
});
