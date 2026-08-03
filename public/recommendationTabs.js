const style = document.createElement("style");
style.dataset.pulsehftRecommendationTabs = "true";
style.textContent = String.raw`
.recommendation-trigger{display:none!important}
.recommendation-workspace-tabs{display:inline-flex;align-items:center;gap:3px;padding:3px;border:1px solid #26384f;border-radius:10px;background:#09111d;white-space:nowrap}
.recommendation-workspace-tab{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:26px;border:0;border-radius:7px;background:transparent;color:#71849b;padding:0 9px;font-size:9px;font-weight:900}
.recommendation-workspace-tab:hover{color:#d8f8ff;background:#101d2d}
.recommendation-workspace-tab.active{color:#dffbff;background:linear-gradient(180deg,#15304a,#102237);box-shadow:inset 0 0 0 1px #2d5b78}
.recommendation-tab-count{display:inline-grid;place-items:center;min-width:18px;height:18px;border-radius:999px;padding:0 5px;background:#17283b;color:#8fdff0;font-size:8px}
.recommendation-workspace-tab.active .recommendation-tab-count{background:#25506b;color:#e8fdff}
.recommendation-tab-ready{width:6px;height:6px;border-radius:50%;background:#52657a}
.recommendation-tab-ready.live{background:#4ee5ba;box-shadow:0 0 10px rgba(78,229,186,.75)}
body.recommendation-open{overflow:auto!important}
body.recommendation-view-active #app> :not(.topbar){display:none!important}
body.recommendation-view-active #app{padding-bottom:0}
body.recommendation-view-active #app.loading-screen{display:block;min-height:0}
.recommendation-backdrop{position:static!important;inset:auto!important;z-index:auto!important;width:auto!important;max-width:1880px;margin:0 auto!important;padding:12px 24px 24px!important;background:transparent!important;backdrop-filter:none!important;overflow:visible!important}
body:not(.recommendation-view-active) .recommendation-backdrop{display:none!important}
.recommendation-panel{width:100%!important;max-width:none!important;margin:0!important;box-shadow:0 24px 70px rgba(0,0,0,.38)!important}
.recommendation-close{display:none!important}
@media(max-width:1400px){.recommendation-workspace-tab{padding:0 7px}.recommendation-workspace-tabs{margin-right:2px}}
`;
document.head.append(style);

const VIEW_KEY = "pulsehft.activeWorkspaceView";
const FILTER_KEY = "pulsehft.recommendationFilter";
const VIEW_MAIN = "MAIN";
const VIEW_RECOMMENDATIONS = "RECOMMENDATIONS";
const FILTERS = new Set(["ALL", "PULLBACK", "REVERSAL", "BLOCKED"]);

let activeView = readStorage(VIEW_KEY) === VIEW_RECOMMENDATIONS
  ? VIEW_RECOMMENDATIONS
  : VIEW_MAIN;
let mainScrollY = 0;
let recommendationScrollY = 0;
let tableScrollLeft = 0;
let tableScrollTop = 0;
let filterRestored = false;
let candidateCount = 0;
let entryReadyCount = 0;
let selectingSymbol = null;

const app = document.querySelector("#app");
const overlay = document.querySelector(".recommendation-backdrop");

function ensureTabs() {
  const topStatus = document.querySelector("#app .top-status");
  if (!topStatus) return;
  let tabs = topStatus.querySelector(".recommendation-workspace-tabs");
  if (!tabs) {
    tabs = document.createElement("div");
    tabs.className = "recommendation-workspace-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "분석 화면 전환");
    tabs.innerHTML = `
      <button type="button" class="recommendation-workspace-tab" role="tab" data-recommendation-tab="main">메인 분석</button>
      <button type="button" class="recommendation-workspace-tab" role="tab" data-recommendation-tab="recommendations"><i class="recommendation-tab-ready"></i>매수추천 <span class="recommendation-tab-count">0</span></button>`;
    topStatus.insertBefore(tabs, topStatus.firstChild);
  }
  syncTabs();
  ensureLegacyOpen();
}

function ensureLegacyOpen() {
  if (!overlay || !overlay.hidden) return;
  const trigger = document.querySelector(".recommendation-trigger");
  if (!trigger) return;
  trigger.click();
  normalizePanelSemantics();
}

function setActiveView(nextView, { restoreScroll = true } = {}) {
  const normalized = nextView === VIEW_RECOMMENDATIONS
    ? VIEW_RECOMMENDATIONS
    : VIEW_MAIN;
  if (activeView === VIEW_RECOMMENDATIONS) recommendationScrollY = window.scrollY;
  else mainScrollY = window.scrollY;
  activeView = normalized;
  writeStorage(VIEW_KEY, activeView);
  document.body.classList.toggle(
    "recommendation-view-active",
    activeView === VIEW_RECOMMENDATIONS,
  );
  syncTabs();
  ensureLegacyOpen();
  if (restoreScroll) {
    const targetY = activeView === VIEW_RECOMMENDATIONS
      ? recommendationScrollY
      : mainScrollY;
    requestAnimationFrame(() => window.scrollTo(0, targetY));
  }
}

function syncTabs() {
  for (const tab of document.querySelectorAll("[data-recommendation-tab]")) {
    const recommendationTab = tab.dataset.recommendationTab === "recommendations";
    const selected = recommendationTab
      ? activeView === VIEW_RECOMMENDATIONS
      : activeView === VIEW_MAIN;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (recommendationTab) {
      const count = tab.querySelector(".recommendation-tab-count");
      if (count) count.textContent = String(candidateCount);
      tab.querySelector(".recommendation-tab-ready")
        ?.classList.toggle("live", entryReadyCount > 0);
      tab.title = entryReadyCount > 0
        ? `추천 ${candidateCount}종목 · ENTRY_READY ${entryReadyCount}종목`
        : `추천 ${candidateCount}종목`;
    }
  }
}

async function refreshTabStatus() {
  try {
    const response = await fetch("/api/recommendations", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return;
    const result = await response.json();
    candidateCount = Array.isArray(result.candidates) ? result.candidates.length : 0;
    entryReadyCount = Number(result.realtimeStateCounts?.ENTRY_READY ?? 0);
    syncTabs();
  } catch {
    // 추천 본 화면이 오류를 표시하므로 탭 배지 갱신 실패는 조용히 유지합니다.
  }
}

function normalizePanelSemantics() {
  const panel = overlay?.querySelector(".recommendation-panel");
  if (!panel) return;
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "매수추천 리스트");
  panel.removeAttribute("aria-modal");
  restoreTableScroll();
  restoreFilter();
}

function captureTableScroll() {
  const wrap = overlay?.querySelector(".recommendation-table-wrap");
  if (!wrap) return;
  tableScrollLeft = wrap.scrollLeft;
  tableScrollTop = wrap.scrollTop;
}

function restoreTableScroll() {
  const wrap = overlay?.querySelector(".recommendation-table-wrap");
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
  const button = overlay?.querySelector(`[data-recommendation-action="filter"][data-filter="${stored}"]`);
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
  const tab = event.target.closest("[data-recommendation-tab]");
  if (tab) {
    event.preventDefault();
    setActiveView(
      tab.dataset.recommendationTab === "recommendations"
        ? VIEW_RECOMMENDATIONS
        : VIEW_MAIN,
    );
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
  if (event.target === overlay) {
    event.preventDefault();
    event.stopImmediatePropagation();
    setActiveView(VIEW_MAIN);
  }
}

function handleKeydown(event) {
  if (event.key === "Escape" && activeView === VIEW_RECOMMENDATIONS) {
    event.preventDefault();
    event.stopImmediatePropagation();
    setActiveView(VIEW_MAIN);
    return;
  }
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  if (!event.target.closest(".recommendation-workspace-tabs")) return;
  event.preventDefault();
  setActiveView(
    activeView === VIEW_MAIN ? VIEW_RECOMMENDATIONS : VIEW_MAIN,
  );
}

function readStorage(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, value); } catch {
    // 저장소가 차단돼도 현재 세션의 탭 전환은 유지합니다.
  }
}

if (app) {
  new MutationObserver(ensureTabs).observe(app, { childList: true, subtree: true });
}
if (overlay) {
  overlay.addEventListener("scroll", captureTableScroll, true);
  new MutationObserver(normalizePanelSemantics).observe(overlay, {
    childList: true,
    subtree: true,
  });
}
document.addEventListener("click", handleClick, true);
document.addEventListener("keydown", handleKeydown, true);

setActiveView(activeView, { restoreScroll: false });
ensureTabs();
ensureLegacyOpen();
normalizePanelSemantics();
void refreshTabStatus();
const statusTimer = setInterval(() => void refreshTabStatus(), 15_000);
window.addEventListener("beforeunload", () => clearInterval(statusTimer));
