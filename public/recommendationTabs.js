const style = document.createElement("style");
style.dataset.pulsehftRecommendationTabs = "true";
style.textContent = String.raw`
.recommendation-trigger{display:none!important}
.recommendation-tabs-portal{position:fixed;z-index:45;left:0;top:0;pointer-events:none}
.recommendation-tabs-portal[hidden]{display:none!important}
.recommendation-tabs-portal .recommendation-workspace-tabs{pointer-events:auto}
.recommendation-workspace-tabs{display:inline-flex;align-items:center;gap:3px;padding:3px;border:1px solid #26384f;border-radius:10px;background:#09111d;white-space:nowrap;box-shadow:0 8px 24px rgba(0,0,0,.28)}
.recommendation-workspace-tab{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:26px;border:0;border-radius:7px;background:transparent;color:#71849b;padding:0 9px;font-size:9px;font-weight:900}
.recommendation-workspace-tab:hover{color:#d8f8ff;background:#101d2d}
.recommendation-workspace-tab.active{color:#dffbff;background:linear-gradient(180deg,#15304a,#102237);box-shadow:inset 0 0 0 1px #2d5b78}
.recommendation-tab-count{display:inline-grid;place-items:center;min-width:18px;height:18px;border-radius:999px;padding:0 5px;background:#17283b;color:#8fdff0;font-size:8px}
.recommendation-workspace-tab.active .recommendation-tab-count{background:#25506b;color:#e8fdff}
.recommendation-tab-ready{width:6px;height:6px;border-radius:50%;background:#52657a}
.recommendation-tab-ready.live{background:#4ee5ba;box-shadow:0 0 10px rgba(78,229,186,.75)}
.recommendation-tab-ready.warning{background:#ffbf69;box-shadow:0 0 10px rgba(255,191,105,.6)}
body.recommendation-open{overflow:auto!important}
body.recommendation-view-active #app.app-shell> :not(.topbar),
body.kis-paper-view-active #app.app-shell> :not(.topbar){display:none!important}
body.recommendation-view-active #app.app-shell,
body.kis-paper-view-active #app.app-shell{padding-bottom:0}
.recommendation-backdrop{position:static!important;inset:auto!important;z-index:auto!important;width:auto!important;max-width:1880px;margin:0 auto!important;padding:12px 24px 24px!important;background:transparent!important;backdrop-filter:none!important;overflow:visible!important}
body:not(.recommendation-view-active) .recommendation-backdrop,
body.kis-paper-view-active .recommendation-backdrop{display:none!important}
.recommendation-panel{width:100%!important;max-width:none!important;margin:0!important;box-shadow:0 24px 70px rgba(0,0,0,.38)!important}
.recommendation-close{display:none!important}
.kis-paper-workspace{max-width:1880px;margin:0 auto;padding:12px 24px 28px;color:#d7e5f3}
body:not(.kis-paper-view-active) .kis-paper-workspace{display:none!important}
.kis-paper-shell{display:grid;gap:14px}
.kis-paper-hero,.kis-paper-card{border:1px solid #24364c;border-radius:16px;background:linear-gradient(180deg,#0d1725,#09111c);box-shadow:0 22px 60px rgba(0,0,0,.28)}
.kis-paper-hero{display:flex;justify-content:space-between;gap:18px;padding:20px 22px}
.kis-paper-hero h2{margin:3px 0 7px;font-size:22px}
.kis-paper-hero p{margin:0;max-width:900px;color:#8093a9;font-size:12px;line-height:1.65}
.kis-paper-eyebrow{color:#67d8ee;font-size:10px;font-weight:900;letter-spacing:.12em}
.kis-paper-badges{display:flex;align-items:flex-start;justify-content:flex-end;gap:7px;flex-wrap:wrap}
.kis-paper-badge{display:inline-flex;align-items:center;min-height:26px;padding:0 9px;border:1px solid #2e4964;border-radius:999px;background:#102237;color:#a7cee2;font-size:9px;font-weight:900}
.kis-paper-badge.safe{border-color:#1e695e;background:#0d2d2b;color:#79efd2}
.kis-paper-badge.warn{border-color:#73542e;background:#2b2114;color:#ffd08c}
.kis-paper-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px}
.kis-paper-toolbar button,.kis-paper-order-buttons button{border:0;border-radius:9px;min-height:34px;padding:0 12px;font-weight:900;cursor:pointer}
.kis-paper-toolbar button{background:#13263b;color:#b8d4e8;border:1px solid #284762}
.kis-paper-toolbar button:disabled,.kis-paper-order-buttons button:disabled{cursor:not-allowed;opacity:.45}
.kis-paper-grid{display:grid;grid-template-columns:minmax(0,1.08fr) minmax(420px,.92fr);gap:14px}
.kis-paper-card{padding:18px}
.kis-paper-card h3{margin:2px 0 14px;font-size:15px}
.kis-paper-status-line{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.kis-paper-status-line small{color:#70849b}
.kis-paper-error{padding:11px 12px;border:1px solid #6c3541;border-radius:10px;background:#28131a;color:#ff9bab;font-size:11px;line-height:1.55}
.kis-paper-summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin-bottom:14px}
.kis-paper-summary div{padding:12px;border:1px solid #203249;border-radius:11px;background:#0a1421}
.kis-paper-summary span{display:block;color:#70849b;font-size:9px;margin-bottom:5px}
.kis-paper-summary strong{font-size:14px}
.kis-paper-positive{color:#68ebc2!important}.kis-paper-negative{color:#ff8397!important}
.kis-paper-table-wrap{overflow:auto;border:1px solid #203249;border-radius:11px}
.kis-paper-table{width:100%;border-collapse:collapse;min-width:760px;font-size:10px}
.kis-paper-table th,.kis-paper-table td{padding:10px 11px;border-bottom:1px solid #17273a;text-align:right;white-space:nowrap}
.kis-paper-table th{position:sticky;top:0;background:#101d2d;color:#71869d;font-size:9px}
.kis-paper-table th:first-child,.kis-paper-table td:first-child{text-align:left}
.kis-paper-empty{padding:28px 12px;text-align:center;color:#64788f;font-size:11px}
.kis-paper-quote{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:end;padding:12px;border:1px solid #24435f;border-radius:12px;background:#0c1a29;margin-bottom:12px}
.kis-paper-quote span{display:block;color:#6f849c;font-size:9px;margin-bottom:4px}
.kis-paper-quote strong{font-size:19px}.kis-paper-quote small{color:#71869d;font-size:9px;text-align:right}
.kis-paper-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.kis-paper-form label{display:grid;gap:5px;color:#7f93aa;font-size:9px;font-weight:800}
.kis-paper-form select,.kis-paper-form input{width:100%;height:36px;border:1px solid #29445f;border-radius:9px;background:#08121e;color:#dceaf6;padding:0 10px;outline:none}
.kis-paper-form .wide{grid-column:1/-1}
.kis-paper-order-buttons{display:grid;grid-template-columns:1fr 1fr;gap:9px;grid-column:1/-1;margin-top:2px}
.kis-paper-buy{background:#123e35;color:#77f1ca}.kis-paper-sell{background:#49202b;color:#ff9aae}
.kis-paper-note{grid-column:1/-1;margin:2px 0 0;color:#73879f;font-size:9px;line-height:1.55}
.kis-paper-history{display:grid;gap:8px;max-height:330px;overflow:auto}
.kis-paper-history-row{display:grid;grid-template-columns:1.2fr .8fr .8fr 1fr 1fr;gap:8px;align-items:center;padding:10px 11px;border:1px solid #1f3147;border-radius:10px;background:#0a1421;font-size:9px}
.kis-paper-history-row strong{font-size:10px}.kis-paper-history-row span{color:#8194aa}
.kis-paper-history-status{justify-self:end;font-weight:900}.kis-paper-history-status.accepted{color:#6eeac5}.kis-paper-history-status.rejected,.kis-paper-history-status.unknown{color:#ff91a5}
@media(max-width:1400px){.recommendation-workspace-tab{padding:0 7px}.recommendation-workspace-tabs{margin-right:2px}.kis-paper-summary{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:980px){.kis-paper-grid{grid-template-columns:1fr}.kis-paper-hero{flex-direction:column}.kis-paper-badges{justify-content:flex-start}.kis-paper-summary{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;
document.head.append(style);

const VIEW_KEY = "pulsehft.activeWorkspaceView";
const FILTER_KEY = "pulsehft.recommendationFilter";
const KIS_COMMANDS_KEY = "pulsehft.kisPaperCommands";
const VIEW_MAIN = "MAIN";
const VIEW_RECOMMENDATIONS = "RECOMMENDATIONS";
const VIEW_KIS_PAPER = "KIS_PAPER";
const FILTERS = new Set(["ALL", "PULLBACK", "REVERSAL", "BLOCKED"]);
const VIEWS = new Set([VIEW_MAIN, VIEW_RECOMMENDATIONS, VIEW_KIS_PAPER]);

const app = document.querySelector("#app");
const tabsPortal = document.createElement("div");
tabsPortal.className = "recommendation-tabs-portal";
tabsPortal.hidden = true;
tabsPortal.innerHTML = `
  <div class="recommendation-workspace-tabs" role="tablist" aria-label="분석 화면 전환">
    <button type="button" class="recommendation-workspace-tab" role="tab" data-recommendation-tab="main">메인 분석</button>
    <button type="button" class="recommendation-workspace-tab" role="tab" data-recommendation-tab="recommendations"><i class="recommendation-tab-ready"></i>매수추천 <span class="recommendation-tab-count">0</span></button>
    <button type="button" class="recommendation-workspace-tab" role="tab" data-recommendation-tab="kis-paper"><i class="recommendation-tab-ready"></i>KIS 모의투자</button>
  </div>`;
document.body.append(tabsPortal);

const kisPaperWorkspace = document.createElement("section");
kisPaperWorkspace.className = "kis-paper-workspace";
kisPaperWorkspace.setAttribute("role", "region");
kisPaperWorkspace.setAttribute("aria-label", "한국투자 모의투자 수동 주문");
document.body.append(kisPaperWorkspace);

const storedView = readStorage(VIEW_KEY);
let pendingInitialView = VIEWS.has(storedView) ? storedView : VIEW_MAIN;
let activeView = VIEW_MAIN;
let initialViewRestored = false;
let ensureTabsScheduled = false;
let panelOpenTimer = null;
let panelOpenAttempts = 0;
let observedPanel = null;
let observedOverlay = null;
let panelObserver = null;
let tableScrollLeft = 0;
let tableScrollTop = 0;
let filterRestored = false;
let candidateCount = 0;
let entryReadyCount = 0;
let selectingSymbol = null;
const scrollPositions = new Map([
  [VIEW_MAIN, 0],
  [VIEW_RECOMMENDATIONS, 0],
  [VIEW_KIS_PAPER, 0],
]);

let kisPaperStatus = null;
let kisPaperBalance = null;
let kisPaperQuote = null;
let kisPaperSnapshot = null;
let kisPaperBusy = false;
let kisPaperError = null;
let kisPaperFetchedAt = 0;
let kisPaperOrderType = "MARKET";
let kisPaperQuantity = 1;
let kisPaperLimitPrice = null;
let kisPaperCommands = readStoredCommands();

function getOverlay() {
  return document.querySelector(".recommendation-backdrop");
}

function isWorkspaceReady() {
  return Boolean(
    app?.classList.contains("app-shell")
    && app.querySelector(".topbar .top-status"),
  );
}

function isRecommendationPanelOpen() {
  const overlay = getOverlay();
  return Boolean(overlay && !overlay.hidden);
}

function applyViewClass() {
  const ready = isWorkspaceReady();
  document.body.classList.toggle(
    "recommendation-view-active",
    ready && activeView === VIEW_RECOMMENDATIONS && isRecommendationPanelOpen(),
  );
  document.body.classList.toggle(
    "kis-paper-view-active",
    ready && activeView === VIEW_KIS_PAPER,
  );
}

function positionTabs(topStatus) {
  const tabs = tabsPortal.querySelector(".recommendation-workspace-tabs");
  if (!tabs || !topStatus?.isConnected) {
    tabsPortal.hidden = true;
    return;
  }

  tabsPortal.hidden = false;
  const statusRect = topStatus.getBoundingClientRect();
  const firstStatusItem = [...topStatus.children].find((element) => {
    const computed = window.getComputedStyle(element);
    return computed.display !== "none" && computed.visibility !== "hidden";
  });
  const firstRect = firstStatusItem?.getBoundingClientRect();
  const tabsRect = tabs.getBoundingClientRect();
  const gap = 12;
  const desiredLeft = (firstRect?.left ?? statusRect.right) - gap - tabsRect.width;
  const left = Math.max(8, Math.min(desiredLeft, window.innerWidth - tabsRect.width - 8));
  const top = statusRect.top + Math.max(0, (statusRect.height - tabsRect.height) / 2);

  tabsPortal.style.transform = `translate(${Math.round(left)}px,${Math.round(top)}px)`;
}

function scheduleEnsureTabs() {
  if (ensureTabsScheduled) return;
  ensureTabsScheduled = true;
  requestAnimationFrame(() => {
    ensureTabsScheduled = false;
    ensureTabs();
  });
}

function ensureTabs() {
  const topStatus = app?.querySelector(".topbar .top-status");
  if (!topStatus) {
    tabsPortal.hidden = true;
    document.body.classList.remove("recommendation-view-active", "kis-paper-view-active");
    return;
  }

  positionTabs(topStatus);
  bindPanelObserver();

  if (!initialViewRestored) {
    initialViewRestored = true;
    activeView = pendingInitialView;
    if (activeView === VIEW_RECOMMENDATIONS) schedulePanelOpen();
    if (activeView === VIEW_KIS_PAPER) void activateKisPaperWorkspace();
  }

  applyViewClass();
  syncTabs();
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
  panelObserver = new MutationObserver(() => normalizePanelSemantics());
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
      writeStorage(VIEW_KEY, VIEW_MAIN);
      applyViewClass();
      syncTabs();
      return;
    }
    panelOpenTimer = setTimeout(attempt, 50);
  };

  attempt();
}

function normalizeView(nextView) {
  return VIEWS.has(nextView) ? nextView : VIEW_MAIN;
}

function setActiveView(nextView, { restoreScroll = true } = {}) {
  const normalized = normalizeView(nextView);
  pendingInitialView = normalized;

  if (!isWorkspaceReady()) {
    activeView = VIEW_MAIN;
    document.body.classList.remove("recommendation-view-active", "kis-paper-view-active");
    return;
  }

  scrollPositions.set(activeView, window.scrollY);
  activeView = normalized;
  writeStorage(VIEW_KEY, activeView);

  clearTimeout(panelOpenTimer);
  panelOpenTimer = null;
  if (activeView === VIEW_RECOMMENDATIONS) schedulePanelOpen();
  if (activeView === VIEW_KIS_PAPER) void activateKisPaperWorkspace();

  applyViewClass();
  syncTabs();

  if (restoreScroll) {
    const targetY = scrollPositions.get(activeView) ?? 0;
    requestAnimationFrame(() => window.scrollTo(0, targetY));
  }
}

function viewForTab(tab) {
  if (tab === "recommendations") return VIEW_RECOMMENDATIONS;
  if (tab === "kis-paper") return VIEW_KIS_PAPER;
  return VIEW_MAIN;
}

function syncTabs() {
  for (const tab of tabsPortal.querySelectorAll("[data-recommendation-tab]")) {
    const tabView = viewForTab(tab.dataset.recommendationTab);
    const selected = activeView === tabView;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;

    if (tabView === VIEW_RECOMMENDATIONS) {
      const count = tab.querySelector(".recommendation-tab-count");
      if (count && count.textContent !== String(candidateCount)) {
        count.textContent = String(candidateCount);
      }
      tab.querySelector(".recommendation-tab-ready")
        ?.classList.toggle("live", entryReadyCount > 0);
      tab.title = entryReadyCount > 0
        ? `추천 ${candidateCount}종목 · ENTRY_READY ${entryReadyCount}종목`
        : `추천 ${candidateCount}종목`;
    }

    if (tabView === VIEW_KIS_PAPER) {
      const service = kisPaperStatus?.service;
      const ready = Boolean(kisPaperStatus?.enabled && kisPaperStatus?.orderApiAvailable);
      const warning = Boolean(service?.killSwitch || service?.unknownResult);
      const indicator = tab.querySelector(".recommendation-tab-ready");
      indicator?.classList.toggle("live", ready && !warning);
      indicator?.classList.toggle("warning", warning);
      tab.title = warning
        ? "KIS 모의투자 주문 보호 상태"
        : ready
          ? "KIS 모의투자 수동 주문"
          : "KIS 모의투자 비활성";
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
  const button = getOverlay()?.querySelector(
    `[data-recommendation-action="filter"][data-filter="${stored}"]`,
  );
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

async function fetchJson(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error ?? `요청 실패 (${response.status})`);
    error.code = result.code ?? null;
    error.ambiguous = Boolean(result.ambiguous);
    throw error;
  }
  return result;
}

async function activateKisPaperWorkspace() {
  renderKisPaperWorkspace();
  if (Date.now() - kisPaperFetchedAt < 5_000 && kisPaperStatus) return;
  await refreshKisPaperWorkspace();
}

async function refreshKisPaperWorkspace() {
  kisPaperBusy = true;
  kisPaperError = null;
  renderKisPaperWorkspace();
  try {
    const [status, snapshot] = await Promise.all([
      fetchJson("/api/kis/paper/status"),
      fetchJson("/api/snapshot"),
    ]);
    const previousSymbol = kisPaperSnapshot?.symbol ?? null;
    kisPaperStatus = status;
    kisPaperSnapshot = snapshot;

    if (status.enabled && status.balanceApiAvailable) {
      const [balance, quote] = await Promise.all([
        fetchJson("/api/kis/paper/balance"),
        fetchJson(`/api/kis/quote?symbol=${encodeURIComponent(snapshot.symbol)}&market=UN`),
      ]);
      kisPaperBalance = balance;
      kisPaperQuote = quote;
      const currentPrice = Number(quote.currentPrice);
      if (Number.isFinite(currentPrice) && currentPrice > 0) {
        if (kisPaperLimitPrice === null || previousSymbol !== snapshot.symbol) {
          kisPaperLimitPrice = currentPrice;
        }
      }
    } else {
      kisPaperBalance = null;
      kisPaperQuote = null;
    }
    kisPaperFetchedAt = Date.now();
  } catch (error) {
    kisPaperError = error instanceof Error ? error.message : "KIS 모의투자 정보를 불러오지 못했습니다.";
  } finally {
    kisPaperBusy = false;
    renderKisPaperWorkspace();
    syncTabs();
  }
}

function numberTone(value) {
  const number = Number(value) || 0;
  return number > 0 ? "kis-paper-positive" : number < 0 ? "kis-paper-negative" : "";
}

function formatNumber(value, digits = 0) {
  const number = Number(value) || 0;
  return number.toLocaleString("ko-KR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatTimestamp(value) {
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric) ? numeric : Date.parse(String(value ?? ""));
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "-";
  return new Date(timestamp).toLocaleString("ko-KR", { hour12: false });
}

function renderPositions() {
  const positions = Array.isArray(kisPaperBalance?.positions) ? kisPaperBalance.positions : [];
  if (positions.length === 0) return '<div class="kis-paper-empty">KIS 모의계좌 보유종목이 없습니다.</div>';
  return `<div class="kis-paper-table-wrap"><table class="kis-paper-table"><thead><tr><th>종목</th><th>수량</th><th>주문가능</th><th>평균매입가</th><th>현재가</th><th>평가손익</th><th>수익률</th></tr></thead><tbody>${positions.map((position) => `
    <tr>
      <td><strong>${escapeHtml(position.name ?? "-")}</strong><br><span>${escapeHtml(position.symbol ?? "-")}</span></td>
      <td>${formatNumber(position.quantity)}주</td>
      <td>${formatNumber(position.orderableQuantity)}주</td>
      <td>${formatNumber(position.averagePrice)}원</td>
      <td>${formatNumber(position.currentPrice)}원</td>
      <td class="${numberTone(position.evaluationProfitLoss)}">${formatNumber(position.evaluationProfitLoss)}원</td>
      <td class="${numberTone(position.evaluationProfitLossRate)}">${formatNumber(position.evaluationProfitLossRate, 2)}%</td>
    </tr>`).join("")}</tbody></table></div>`;
}

function renderCommandHistory() {
  if (kisPaperCommands.length === 0) {
    return '<div class="kis-paper-empty">이 브라우저에서 전송한 KIS 모의주문 명령이 없습니다.</div>';
  }
  return `<div class="kis-paper-history">${kisPaperCommands.map((command) => {
    const statusClass = command.status === "ACCEPTED"
      ? "accepted"
      : command.status === "UNKNOWN_RESULT"
        ? "unknown"
        : "rejected";
    const orderNumber = command.orderNumber ? `주문번호 ${escapeHtml(command.orderNumber)}` : escapeHtml(command.code ?? "-");
    return `<div class="kis-paper-history-row">
      <strong>${command.side === "BUY" ? "매수" : "매도"} ${formatNumber(command.quantity)}주</strong>
      <span>${escapeHtml(command.symbol)}</span>
      <span>${command.type === "MARKET" ? "시장가" : `지정가 ${formatNumber(command.limitPrice)}`}</span>
      <span>${orderNumber}</span>
      <span class="kis-paper-history-status ${statusClass}">${escapeHtml(command.status)}${command.replayed ? " · 재생" : ""}</span>
    </div>`;
  }).join("")}</div>`;
}

function renderKisPaperWorkspace() {
  const service = kisPaperStatus?.service ?? {};
  const enabled = Boolean(kisPaperStatus?.enabled && kisPaperStatus?.balanceApiAvailable && kisPaperStatus?.orderApiAvailable);
  const protectedState = Boolean(service.killSwitch || service.unknownResult);
  const orderDisabled = kisPaperBusy || !enabled || protectedState || !kisPaperQuote;
  const summary = kisPaperBalance?.summary ?? {};
  const symbol = kisPaperSnapshot?.symbol ?? "-";
  const symbolName = kisPaperSnapshot?.symbolName ?? "선택 종목 없음";
  const currentPrice = Number(kisPaperQuote?.currentPrice) || 0;
  const quoteFetchedAt = kisPaperQuote?.fetchedAt ?? null;
  const limitDisabled = kisPaperOrderType === "MARKET" || orderDisabled;

  kisPaperWorkspace.innerHTML = `<div class="kis-paper-shell">
    <div class="kis-paper-hero">
      <div>
        <span class="kis-paper-eyebrow">SEPARATE BROKER WORKSPACE</span>
        <h2>KIS 모의투자</h2>
        <p>내부 MarketSimulator와 PaperTrader를 사용하지 않습니다. 현재가는 KIS 실전계좌의 읽기 전용 시세이고, 잔고와 주문은 KIS 모의계좌입니다. 자동전략과 매수추천 자동주문은 연결되어 있지 않습니다.</p>
      </div>
      <div class="kis-paper-badges">
        <span class="kis-paper-badge">KIS PROD READ-ONLY 시세</span>
        <span class="kis-paper-badge">KIS PAPER ACCOUNT</span>
        <span class="kis-paper-badge safe">수동 주문 전용</span>
        <span class="kis-paper-badge ${protectedState ? "warn" : "safe"}">${protectedState ? "주문 보호 상태" : "자동주문 미연결"}</span>
      </div>
    </div>

    <div class="kis-paper-toolbar">
      <div><span class="kis-paper-eyebrow">LAST SYNC</span> <small>${kisPaperFetchedAt ? formatTimestamp(kisPaperFetchedAt) : "조회 전"}</small></div>
      <button type="button" data-kis-action="refresh" ${kisPaperBusy ? "disabled" : ""}>${kisPaperBusy ? "조회 중" : "새로고침"}</button>
    </div>

    ${kisPaperError ? `<div class="kis-paper-error">${escapeHtml(kisPaperError)}</div>` : ""}
    ${!enabled && kisPaperStatus ? '<div class="kis-paper-error">KIS PAPER_TRADING 설정이 비활성화되어 있습니다. 이 화면에서는 내부 모의주문으로 대체하지 않습니다.</div>' : ""}

    <div class="kis-paper-grid">
      <div class="kis-paper-card">
        <div class="kis-paper-status-line"><div><span class="kis-paper-eyebrow">BROKER BALANCE</span><h3>KIS 모의계좌 잔고</h3></div><small>${kisPaperBalance ? `조회 ${formatTimestamp(kisPaperBalance.fetchedAt)}` : "-"}</small></div>
        <div class="kis-paper-summary">
          <div><span>현금</span><strong>${formatNumber(summary.cash)}원</strong></div>
          <div><span>총평가금액</span><strong>${formatNumber(summary.totalEvaluationAmount)}원</strong></div>
          <div><span>매입금액</span><strong>${formatNumber(summary.purchaseAmount)}원</strong></div>
          <div><span>평가손익</span><strong class="${numberTone(summary.evaluationProfitLoss)}">${formatNumber(summary.evaluationProfitLoss)}원</strong></div>
          <div><span>자산변동률</span><strong class="${numberTone(summary.assetChangeRate)}">${formatNumber(summary.assetChangeRate, 4)}%</strong></div>
        </div>
        ${renderPositions()}
      </div>

      <div class="kis-paper-card">
        <span class="kis-paper-eyebrow">MANUAL ORDER ONLY</span><h3>KIS 수동 주문</h3>
        <div class="kis-paper-quote"><div><span>${escapeHtml(symbol)} · ${escapeHtml(symbolName)}</span><strong>${formatNumber(currentPrice)}원</strong></div><small>가격 출처: KIS PROD READ-ONLY<br>${formatTimestamp(quoteFetchedAt)}</small></div>
        <div class="kis-paper-form">
          <label>주문 유형<select id="kis-paper-order-type" ${orderDisabled ? "disabled" : ""}><option value="MARKET" ${kisPaperOrderType === "MARKET" ? "selected" : ""}>시장가</option><option value="LIMIT" ${kisPaperOrderType === "LIMIT" ? "selected" : ""}>지정가</option></select></label>
          <label>주문 수량<input id="kis-paper-quantity" type="number" min="1" max="${Number(service.limits?.maxOrderQuantity ?? 1_000)}" value="${kisPaperQuantity}" ${orderDisabled ? "disabled" : ""}></label>
          <label class="wide">지정 가격<input id="kis-paper-limit-price" type="number" min="1" step="1" value="${kisPaperLimitPrice ?? currentPrice}" ${limitDisabled ? "disabled" : ""}></label>
          <div class="kis-paper-order-buttons"><button type="button" class="kis-paper-buy" data-kis-action="order" data-side="BUY" ${orderDisabled ? "disabled" : ""}>KIS 모의 매수</button><button type="button" class="kis-paper-sell" data-kis-action="order" data-side="SELL" ${orderDisabled ? "disabled" : ""}>KIS 모의 매도</button></div>
          <p class="kis-paper-note">주문 전 최종 확인을 거칩니다. ACCEPTED는 증권사 주문 접수이며 실제 체결 완료를 의미하지 않습니다. 같은 clientOrderId 재전송은 서버 실행 저널에서 재생 처리됩니다.</p>
        </div>
      </div>
    </div>

    <div class="kis-paper-card">
      <div class="kis-paper-status-line"><div><span class="kis-paper-eyebrow">BROWSER COMMAND RESULTS</span><h3>이 브라우저의 KIS 주문 명령</h3></div><small>실행 저널 전체 또는 체결내역이 아닌 브라우저 전송 결과입니다.</small></div>
      ${renderCommandHistory()}
    </div>
  </div>`;
}

function createKisClientOrderId(side) {
  if (globalThis.crypto?.randomUUID) return `kis-ui-${side.toLowerCase()}-${crypto.randomUUID()}`;
  return `kis-ui-${side.toLowerCase()}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function submitKisPaperOrder(side) {
  if (kisPaperBusy) return;
  const symbol = kisPaperSnapshot?.symbol;
  const symbolName = kisPaperSnapshot?.symbolName ?? symbol;
  const referencePrice = Number(kisPaperQuote?.currentPrice);
  const limitPrice = Number(kisPaperLimitPrice);
  if (!symbol || !Number.isFinite(referencePrice) || referencePrice <= 0) {
    window.alert("KIS 현재가를 먼저 새로고침하세요.");
    return;
  }
  if (!Number.isInteger(kisPaperQuantity) || kisPaperQuantity <= 0) {
    window.alert("주문 수량은 1주 이상이어야 합니다.");
    return;
  }
  if (kisPaperOrderType === "LIMIT" && (!Number.isInteger(limitPrice) || limitPrice <= 0)) {
    window.alert("지정 가격은 양의 정수여야 합니다.");
    return;
  }

  const displayPrice = kisPaperOrderType === "MARKET"
    ? `시장가 · 안전 기준가격 ${formatNumber(referencePrice)}원`
    : `지정가 ${formatNumber(limitPrice)}원`;
  const confirmed = window.confirm(
    `${symbol} ${symbolName}\nKIS 모의 ${side === "BUY" ? "매수" : "매도"} ${kisPaperQuantity}주\n${displayPrice}\n\n주문 접수 요청이며 실제 체결 완료가 아닙니다. 계속하시겠습니까?`,
  );
  if (!confirmed) return;

  const clientOrderId = createKisClientOrderId(side);
  const request = {
    clientOrderId,
    side,
    symbol,
    type: kisPaperOrderType,
    quantity: kisPaperQuantity,
    exchange: "KRX",
    referencePrice,
  };
  if (kisPaperOrderType === "LIMIT") request.limitPrice = limitPrice;

  kisPaperBusy = true;
  kisPaperError = null;
  renderKisPaperWorkspace();
  try {
    const result = await fetchJson("/api/kis/paper/orders", {
      method: "POST",
      body: JSON.stringify(request),
    });
    const brokerResult = result.result ?? {};
    rememberKisCommand({
      clientOrderId,
      symbol,
      symbolName,
      side,
      type: kisPaperOrderType,
      quantity: kisPaperQuantity,
      referencePrice,
      limitPrice: kisPaperOrderType === "LIMIT" ? limitPrice : null,
      status: result.status ?? "UNKNOWN_RESULT",
      replayed: Boolean(result.replayed),
      orderNumber: brokerResult.orderNumber ?? null,
      orderOrganizationNumber: brokerResult.orderOrganizationNumber ?? null,
      code: result.error?.code ?? null,
      recordedAt: Date.now(),
    });
    if (result.status === "UNKNOWN_RESULT") {
      kisPaperError = "주문 결과가 불명확합니다. 추가 주문을 하지 말고 KIS 주문내역과 실행 저널을 대조하세요.";
    } else if (result.status === "REJECTED") {
      kisPaperError = result.error?.message ?? "KIS 모의주문이 거절되었습니다.";
    }
    kisPaperFetchedAt = 0;
  } catch (error) {
    rememberKisCommand({
      clientOrderId,
      symbol,
      symbolName,
      side,
      type: kisPaperOrderType,
      quantity: kisPaperQuantity,
      referencePrice,
      limitPrice: kisPaperOrderType === "LIMIT" ? limitPrice : null,
      status: error?.ambiguous ? "UNKNOWN_RESULT" : "REJECTED",
      replayed: false,
      orderNumber: null,
      orderOrganizationNumber: null,
      code: error?.code ?? null,
      recordedAt: Date.now(),
    });
    kisPaperError = error instanceof Error ? error.message : "KIS 모의주문 요청에 실패했습니다.";
  } finally {
    kisPaperBusy = false;
    await refreshKisPaperWorkspace();
  }
}

function rememberKisCommand(command) {
  kisPaperCommands = [
    command,
    ...kisPaperCommands.filter((item) => item.clientOrderId !== command.clientOrderId),
  ].slice(0, 30);
  try { localStorage.setItem(KIS_COMMANDS_KEY, JSON.stringify(kisPaperCommands)); } catch {
    // 로컬 저장이 차단돼도 현재 세션 기록은 유지합니다.
  }
}

function readStoredCommands() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KIS_COMMANDS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.slice(0, 30) : [];
  } catch {
    return [];
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[char]);
}

function handleClick(event) {
  const tab = event.target.closest("[data-recommendation-tab]");
  if (tab) {
    event.preventDefault();
    setActiveView(viewForTab(tab.dataset.recommendationTab));
    return;
  }

  const kisActionTarget = event.target.closest("[data-kis-action]");
  const kisAction = kisActionTarget?.dataset.kisAction;
  if (kisAction === "refresh") {
    event.preventDefault();
    void refreshKisPaperWorkspace();
    return;
  }
  if (kisAction === "order") {
    event.preventDefault();
    void submitKisPaperOrder(kisActionTarget.dataset.side === "SELL" ? "SELL" : "BUY");
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

  const overlay = getOverlay();
  if (event.target === overlay) {
    event.preventDefault();
    event.stopImmediatePropagation();
    setActiveView(VIEW_MAIN);
  }
}

function handleInput(event) {
  if (event.target.id === "kis-paper-quantity") {
    kisPaperQuantity = Math.max(1, Number(event.target.value) || 1);
  }
  if (event.target.id === "kis-paper-limit-price") {
    kisPaperLimitPrice = Math.max(1, Number(event.target.value) || 1);
  }
}

function handleChange(event) {
  if (event.target.id !== "kis-paper-order-type") return;
  kisPaperOrderType = event.target.value === "LIMIT" ? "LIMIT" : "MARKET";
  if (kisPaperOrderType === "LIMIT" && !kisPaperLimitPrice) {
    kisPaperLimitPrice = Number(kisPaperQuote?.currentPrice) || 1;
  }
  renderKisPaperWorkspace();
}

function handleKeydown(event) {
  if (event.key === "Escape" && activeView !== VIEW_MAIN) {
    event.preventDefault();
    event.stopImmediatePropagation();
    setActiveView(VIEW_MAIN);
    return;
  }
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  if (!event.target.closest(".recommendation-workspace-tabs")) return;
  event.preventDefault();
  const order = [VIEW_MAIN, VIEW_RECOMMENDATIONS, VIEW_KIS_PAPER];
  const currentIndex = Math.max(0, order.indexOf(activeView));
  const delta = event.key === "ArrowRight" ? 1 : -1;
  setActiveView(order[(currentIndex + delta + order.length) % order.length]);
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
  new MutationObserver(scheduleEnsureTabs).observe(app, { childList: true });
}
document.addEventListener("click", handleClick, true);
document.addEventListener("input", handleInput, true);
document.addEventListener("change", handleChange, true);
document.addEventListener("keydown", handleKeydown, true);
window.addEventListener("resize", scheduleEnsureTabs);
window.addEventListener("scroll", scheduleEnsureTabs, { passive: true });

document.body.classList.remove("recommendation-view-active", "kis-paper-view-active");
renderKisPaperWorkspace();
scheduleEnsureTabs();
void refreshTabStatus();
const statusTimer = setInterval(() => void refreshTabStatus(), 15_000);
window.addEventListener("beforeunload", () => {
  clearInterval(statusTimer);
  clearTimeout(panelOpenTimer);
  panelObserver?.disconnect();
});
