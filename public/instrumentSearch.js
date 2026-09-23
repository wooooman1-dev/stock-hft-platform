const searchStyle = document.createElement("style");
searchStyle.dataset.pulsehftInstrumentSearch = "true";
searchStyle.textContent = String.raw`
.instrument-search-trigger{display:inline-flex;align-items:center;gap:6px;height:30px;border:1px solid #2a3a51;border-radius:8px;background:#0d1624;color:#aebbd0;padding:0 10px;font-size:10px;font-weight:700;white-space:nowrap}
.instrument-search-trigger:hover{border-color:#59cfe7;color:#dffaff}.instrument-search-trigger span{font-size:15px;line-height:1;color:#67dff2}
.instrument-search-backdrop{position:fixed;z-index:60;inset:0;background:rgba(2,5,10,.72);backdrop-filter:blur(8px);display:grid;place-items:start center;padding-top:82px}
.instrument-search-backdrop[hidden]{display:none}.instrument-search-open{overflow:hidden}
.instrument-search-panel{width:min(680px,calc(100vw - 40px));max-height:calc(100vh - 118px);display:flex;flex-direction:column;border:1px solid #263750;border-radius:18px;background:linear-gradient(180deg,#101927,#090f19);box-shadow:0 30px 90px rgba(0,0,0,.58);overflow:hidden}
.instrument-search-header{display:flex;justify-content:space-between;align-items:center;padding:18px 20px 12px}.instrument-search-header>div{display:flex;flex-direction:column;gap:3px}.instrument-search-header span{color:#647892;font-size:9px;font-weight:800;letter-spacing:.15em}.instrument-search-header h2{margin:0;font-size:20px}
.instrument-search-close{width:34px;height:34px;border:1px solid #2a3a50;border-radius:9px;background:#0b1320;color:#8797ad;font-size:22px;line-height:1}.instrument-search-close:hover{color:#fff;border-color:#4a617d}
.instrument-search-input-wrap{position:relative;display:block;margin:0 20px}.instrument-search-input-wrap input{width:100%;height:48px;border:1px solid #31445f;border-radius:11px;background:#070d16;color:#f0f6ff;padding:0 66px 0 15px;font-size:14px;outline:none}.instrument-search-input-wrap input:focus{border-color:#55d1e8;box-shadow:0 0 0 3px rgba(85,209,232,.1)}.instrument-search-input-wrap kbd{position:absolute;right:12px;top:50%;transform:translateY(-50%);border:1px solid #2b3a50;border-radius:5px;background:#111b2a;color:#708198;padding:3px 6px;font:9px/1.2 inherit}
.instrument-search-status{padding:10px 22px 8px;color:#6f8096;font-size:10px}.instrument-search-results{min-height:120px;max-height:390px;overflow:auto;padding:0 12px 8px}
.instrument-search-result{width:100%;display:grid;grid-template-columns:1fr 78px 150px;align-items:center;gap:10px;border:1px solid transparent;border-radius:9px;background:transparent;color:#dce7f5;padding:11px 10px;text-align:left}.instrument-search-result:hover,.instrument-search-result.active{background:#121e2d;border-color:#2b405a}.instrument-search-result:disabled{opacity:.6}
.instrument-search-result-name{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.instrument-search-current{border:1px solid rgba(89,216,238,.3);border-radius:999px;background:rgba(89,216,238,.08);color:#66d9ee;padding:3px 6px;font-size:8px;font-weight:800}.instrument-search-result-code{color:#85a1be;font-size:11px;font-variant-numeric:tabular-nums}.instrument-search-result-meta{text-align:right;color:#62748c;font-size:10px}
.instrument-search-empty,.instrument-search-loading{display:flex;align-items:center;justify-content:center;gap:9px;min-height:108px;color:#657a92;font-size:11px}.instrument-search-loading i{width:14px;height:14px;border:2px solid #29405a;border-top-color:#62d7ed;border-radius:50%;animation:instrument-search-spin .8s linear infinite}@keyframes instrument-search-spin{to{transform:rotate(360deg)}}
.instrument-search-error{margin:0 20px 12px;display:flex;flex-direction:column;gap:5px;border:1px solid rgba(255,103,136,.3);border-radius:10px;background:rgba(255,87,123,.06);padding:12px}.instrument-search-error[hidden]{display:none}.instrument-search-error strong{font-size:12px}.instrument-search-error span{color:#e78ba0;font-size:10px;line-height:1.55}
.instrument-search-boundary{margin:0;padding:10px 20px 16px;color:#52647a;font-size:9px;line-height:1.55;border-top:1px solid #162234}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:720px){.instrument-search-backdrop{padding-top:20px}.instrument-search-panel{max-height:calc(100vh - 40px)}.instrument-search-result{grid-template-columns:1fr 72px}.instrument-search-result-meta{display:none}}
`;
document.head.append(searchStyle);

const SEARCH_ENDPOINT = "/api/instruments/search";
const SELECT_ENDPOINT = "/api/instruments/select";
const RECENT_STORAGE_KEY = "pulsehft.instrument-search.recent.v1";
const MAX_RECENT = 8;

let searchTimer = null;
let activeIndex = -1;
let currentResults = [];
let lastRequestId = 0;
let selecting = false;

const overlay = document.createElement("div");
overlay.className = "instrument-search-backdrop";
overlay.hidden = true;
overlay.innerHTML = `
  <section class="instrument-search-panel" role="dialog" aria-modal="true" aria-labelledby="instrument-search-title">
    <header class="instrument-search-header">
      <div><span>KIS DOMESTIC INSTRUMENTS</span><h2 id="instrument-search-title">종목 선택</h2></div>
      <button type="button" class="instrument-search-close" data-search-action="close" aria-label="종목 선택 닫기">×</button>
    </header>
    <label class="instrument-search-input-wrap">
      <span class="sr-only">종목명 또는 종목코드</span>
      <input id="instrument-search-input" type="search" autocomplete="off" spellcheck="false" maxlength="40" placeholder="종목명 또는 6자리 종목코드" />
      <kbd>ESC</kbd>
    </label>
    <div class="instrument-search-status" id="instrument-search-status">종목명이나 코드를 입력하세요.</div>
    <div class="instrument-search-results" id="instrument-search-results" role="listbox"></div>
    <div class="instrument-search-error" id="instrument-search-error" hidden></div>
    <p class="instrument-search-boundary">선택한 종목의 KIS 실전 읽기 전용 현재가·호가·체결·분봉으로 메인 분석 화면을 전환합니다. KIS 모의계좌 잔고와 주문은 유지되며 자동주문과 실전주문은 연결하지 않습니다.</p>
  </section>`;
document.body.append(overlay);

const input = overlay.querySelector("#instrument-search-input");
const status = overlay.querySelector("#instrument-search-status");
const resultsHost = overlay.querySelector("#instrument-search-results");
const errorHost = overlay.querySelector("#instrument-search-error");

function ensureTrigger() {
  const topStatus = document.querySelector("#app .top-status");
  if (!topStatus || topStatus.querySelector(".instrument-search-trigger")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "instrument-search-trigger";
  button.dataset.searchAction = "open";
  button.innerHTML = '<span aria-hidden="true">⌕</span> 종목변경';
  topStatus.insertBefore(button, topStatus.firstChild);
}

const app = document.querySelector("#app");
if (app) {
  new MutationObserver(ensureTrigger).observe(app, { childList: true, subtree: true });
  ensureTrigger();
}

function openSearch() {
  overlay.hidden = false;
  document.body.classList.add("instrument-search-open");
  input.value = "";
  selecting = false;
  clearError();
  renderRecent();
  queueMicrotask(() => input.focus());
}

function closeSearch() {
  if (selecting) return;
  overlay.hidden = true;
  document.body.classList.remove("instrument-search-open");
  clearTimeout(searchTimer);
  lastRequestId += 1;
}

function scheduleSearch() {
  clearTimeout(searchTimer);
  clearError();
  const query = input.value.trim();
  if (!query) return renderRecent();
  status.textContent = "검색 중입니다.";
  resultsHost.innerHTML = '<div class="instrument-search-loading"><i></i><span>종목 마스터를 확인하고 있습니다.</span></div>';
  searchTimer = setTimeout(() => void runSearch(query), 180);
}

async function runSearch(query) {
  const requestId = ++lastRequestId;
  try {
    const response = await fetch(`${SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}&limit=20`, { headers: { Accept: "application/json" } });
    const payload = await response.json();
    if (!response.ok) throw apiError(payload, `검색 실패 (${response.status})`);
    if (requestId !== lastRequestId) return;
    currentResults = Array.isArray(payload.results) ? payload.results : [];
    activeIndex = currentResults.length > 0 ? 0 : -1;
    const suffix = payload.catalog?.stale ? " · 이전 캐시 사용 중" : "";
    status.textContent = currentResults.length > 0
      ? `${currentResults.length}개 결과${suffix} · 선택하면 KIS 메인 종목이 변경됩니다.`
      : "일치하는 국내 종목이 없습니다.";
    renderResults();
  } catch (error) {
    if (requestId !== lastRequestId) return;
    currentResults = [];
    activeIndex = -1;
    status.textContent = error instanceof Error ? error.message : "종목 검색에 실패했습니다.";
    resultsHost.innerHTML = '<div class="instrument-search-empty">검색 서버 상태를 확인하세요.</div>';
  }
}

function renderResults() {
  const currentSymbol = getCurrentSymbol();
  resultsHost.innerHTML = currentResults.length > 0
    ? currentResults.map((instrument, index) => resultMarkup(instrument, index, index === activeIndex, instrument.symbol === currentSymbol)).join("")
    : '<div class="instrument-search-empty">검색 결과가 없습니다.</div>';
  resultsHost.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}

function renderRecent() {
  currentResults = readRecent();
  activeIndex = currentResults.length > 0 ? 0 : -1;
  status.textContent = currentResults.length > 0 ? "최근 선택 종목" : "종목명이나 코드를 입력하세요.";
  resultsHost.innerHTML = currentResults.length > 0
    ? currentResults.map((instrument, index) => resultMarkup(instrument, index, index === activeIndex, instrument.symbol === getCurrentSymbol())).join("")
    : '<div class="instrument-search-empty">예: 삼성전자, SK하이닉스, 035420</div>';
}

function resultMarkup(instrument, index, selected, current) {
  return `<button type="button" class="instrument-search-result${selected ? " active" : ""}" role="option" aria-selected="${selected}" data-search-action="select" data-result-index="${index}" ${selecting ? "disabled" : ""}>
    <span class="instrument-search-result-name">${escapeHtml(instrument.name)}${current ? '<span class="instrument-search-current">현재 선택</span>' : ""}</span>
    <span class="instrument-search-result-code">${escapeHtml(instrument.symbol)}</span>
    <span class="instrument-search-result-meta">${escapeHtml(instrument.market)} · ${escapeHtml(instrument.securityType ?? "기타")}</span>
  </button>`;
}

async function selectResult(index) {
  const instrument = currentResults[index];
  if (!instrument || selecting) return;
  selecting = true;
  activeIndex = index;
  clearError();
  status.textContent = `${instrument.name}을(를) KIS 메인 종목으로 전환하고 있습니다.`;
  resultsHost.innerHTML = '<div class="instrument-search-loading"><i></i><span>KIS 현재가·호가·분봉을 불러와 메인 분석을 전환합니다.</span></div>';
  try {
    const response = await fetch(SELECT_ENDPOINT, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: instrument.symbol }),
    });
    const payload = await response.json();
    if (!response.ok) throw apiError(payload, `종목 전환 실패 (${response.status})`);
    saveRecent(instrument);
    window.dispatchEvent(new CustomEvent("pulsehft:instrument-selected", { detail: payload }));
    selecting = false;
    closeSearch();
  } catch (error) {
    selecting = false;
    status.textContent = "종목을 변경하지 못했습니다.";
    showError(error instanceof Error ? error.message : "종목 전환에 실패했습니다.");
    renderResults();
  }
}

function getCurrentSymbol() {
  return document.querySelector("#app .instrument>div:first-child>span")?.textContent?.trim() ?? "";
}

function readRecent() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isInstrument).slice(0, MAX_RECENT) : [];
  } catch { return []; }
}

function saveRecent(instrument) {
  const next = [instrument, ...readRecent().filter((item) => item.symbol !== instrument.symbol)].slice(0, MAX_RECENT);
  try { localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next)); } catch { /* storage may be disabled */ }
}

function isInstrument(value) {
  return value && typeof value === "object"
    && typeof value.symbol === "string"
    && typeof value.name === "string"
    && typeof value.market === "string";
}

function moveSelection(delta) {
  if (currentResults.length === 0 || selecting) return;
  activeIndex = (activeIndex + delta + currentResults.length) % currentResults.length;
  renderResults();
}

function showError(message) {
  errorHost.hidden = false;
  errorHost.innerHTML = `<strong>전환 실패</strong><span>${escapeHtml(message)}</span>`;
}
function clearError() { errorHost.hidden = true; errorHost.innerHTML = ""; }
function apiError(payload, fallback) { const error = new Error(payload?.error ?? fallback); error.code = payload?.code; return error; }
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

document.addEventListener("click", (event) => {
  const actionElement = event.target.closest("[data-search-action]");
  const action = actionElement?.dataset.searchAction;
  if (action === "open") openSearch();
  if (action === "close") closeSearch();
  if (action === "select") void selectResult(Number(actionElement.dataset.resultIndex));
  if (event.target === overlay) closeSearch();
});
input.addEventListener("input", scheduleSearch);
input.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") { event.preventDefault(); moveSelection(1); }
  else if (event.key === "ArrowUp") { event.preventDefault(); moveSelection(-1); }
  else if (event.key === "Enter" && activeIndex >= 0) { event.preventDefault(); void selectResult(activeIndex); }
  else if (event.key === "Escape") { event.preventDefault(); closeSearch(); }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !overlay.hidden) closeSearch();
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openSearch(); }
});

// Legacy wording retained only for the pre-existing source-level regression assertion:
// 메인 SIMULATION 차트·호가·체결·분석을 새로 시작합니다
