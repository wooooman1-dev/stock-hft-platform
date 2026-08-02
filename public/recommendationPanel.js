const style = document.createElement("style");
style.dataset.pulsehftRecommendationPanel = "true";
style.textContent = String.raw`
.recommendation-trigger{display:inline-flex;align-items:center;gap:6px;height:30px;border:1px solid #28405b;border-radius:8px;background:linear-gradient(180deg,#122238,#0b1524);color:#bfeefa;padding:0 11px;font-size:10px;font-weight:800;white-space:nowrap}.recommendation-trigger:hover{border-color:#5fe1f4;color:#fff}.recommendation-trigger i{width:7px;height:7px;border-radius:50%;background:#4ee5ba;box-shadow:0 0 12px rgba(78,229,186,.7)}
.recommendation-backdrop{position:fixed;z-index:39;inset:0;background:rgba(2,5,10,.74);backdrop-filter:blur(8px);padding:58px 24px 24px;overflow:auto}.recommendation-backdrop[hidden]{display:none}.recommendation-open{overflow:hidden}.recommendation-panel{width:min(1240px,100%);margin:0 auto;border:1px solid #243952;border-radius:18px;background:linear-gradient(180deg,#101a29,#080e18);box-shadow:0 30px 90px rgba(0,0,0,.58);overflow:hidden}.recommendation-header{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding:20px 22px 14px;border-bottom:1px solid #17253a}.recommendation-title span{display:block;color:#607892;font-size:9px;font-weight:800;letter-spacing:.15em}.recommendation-title h2{margin:4px 0 5px;font-size:21px}.recommendation-title p{margin:0;color:#71849b;font-size:10px;line-height:1.55}.recommendation-actions{display:flex;align-items:center;gap:8px}.recommendation-actions button{height:34px;border:1px solid #2d425e;border-radius:9px;background:#0c1522;color:#9fb0c5;padding:0 12px;font-size:10px;font-weight:800}.recommendation-actions button:hover{border-color:#5bd6eb;color:#eaffff}.recommendation-actions button:disabled{opacity:.5}.recommendation-close{width:34px;padding:0!important;font-size:20px!important}.recommendation-summary{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;padding:12px 22px;background:#09111c}.recommendation-summary>div{border:1px solid #1c2c40;border-radius:9px;background:#0c1624;padding:10px}.recommendation-summary span{display:block;color:#61748d;font-size:8px;font-weight:800}.recommendation-summary strong{display:block;margin-top:4px;font-size:13px}.recommendation-summary small{display:block;margin-top:3px;color:#52657d;font-size:8px}.recommendation-source-warning{margin:0 22px 12px;border:1px solid rgba(246,192,73,.28);border-radius:9px;background:rgba(246,192,73,.06);color:#d5b96e;padding:10px 12px;font-size:9px;line-height:1.55}.recommendation-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:0 22px 12px}.recommendation-filters{display:flex;gap:6px}.recommendation-filter{height:28px;border:1px solid #26394f;border-radius:8px;background:#0b1421;color:#70839a;padding:0 10px;font-size:9px}.recommendation-filter.active{border-color:#4bcde4;background:rgba(75,205,228,.09);color:#c9f7ff}.recommendation-updated{color:#5d7188;font-size:9px}.recommendation-table-wrap{overflow:auto;padding:0 14px 14px}.recommendation-table{min-width:1120px}.recommendation-head,.recommendation-row{display:grid;grid-template-columns:46px 112px 185px 78px 92px 98px 88px 104px 1fr 94px;align-items:center;gap:8px}.recommendation-head{padding:9px 10px;color:#52677f;font-size:8px;font-weight:800;border-bottom:1px solid #19283a}.recommendation-row{min-height:72px;padding:9px 10px;border-bottom:1px solid #142235;color:#cdd8e7;font-size:10px}.recommendation-row:hover{background:#101c2b}.recommendation-rank{font-size:15px;font-weight:900;color:#5fd9ed}.recommendation-stage{display:inline-flex;justify-content:center;border:1px solid #2b4058;border-radius:999px;padding:5px 7px;font-size:8px;font-weight:900}.stage-confirmation-required{color:#77edd1;border-color:rgba(78,229,186,.35);background:rgba(78,229,186,.08)}.stage-watch{color:#86cfff;border-color:rgba(85,174,238,.3);background:rgba(85,174,238,.07)}.stage-low-priority{color:#8091a7}.stage-blocked{color:#e98ca3;border-color:rgba(244,92,129,.3);background:rgba(244,92,129,.06)}.recommendation-name strong{display:block;font-size:12px}.recommendation-name span{display:block;margin-top:3px;color:#667a91;font-size:9px}.recommendation-type{font-weight:900}.type-pullback{color:#63d8ff}.type-reversal{color:#b895ff}.recommendation-score strong{font-size:17px}.recommendation-score span{color:#60758c}.recommendation-change.positive{color:#ff7e98}.recommendation-change.negative{color:#69b9ff}.recommendation-reasons{color:#8a9caf;line-height:1.45}.recommendation-reasons b{display:block;color:#d7e4f4;font-weight:700}.recommendation-select{height:30px;border:1px solid #2b4661;border-radius:8px;background:#0c1a28;color:#9dddec;font-size:9px;font-weight:800}.recommendation-select:hover{border-color:#62dff2;color:#fff}.recommendation-empty{display:grid;place-items:center;min-height:240px;color:#61748b;font-size:11px}.recommendation-error{margin:0 22px 12px;border:1px solid rgba(247,92,126,.3);border-radius:9px;background:rgba(247,92,126,.06);color:#ec9daf;padding:10px 12px;font-size:9px}.recommendation-error[hidden]{display:none}@media(max-width:760px){.recommendation-backdrop{padding:12px}.recommendation-header{flex-direction:column}.recommendation-summary{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;
document.head.append(style);

const ENDPOINT = "/api/recommendations";
const REFRESH_ENDPOINT = "/api/recommendations/refresh";
let payload = null;
let activeFilter = "ALL";
let loading = false;
let pollTimer = null;

const overlay = document.createElement("div");
overlay.className = "recommendation-backdrop";
overlay.hidden = true;
overlay.innerHTML = '<section class="recommendation-panel" role="dialog" aria-modal="true" aria-label="매수추천 리스트"><div class="recommendation-empty">매수추천 화면을 준비하고 있습니다.</div></section>';
document.body.append(overlay);

function ensureTrigger() {
  const topStatus = document.querySelector("#app .top-status");
  if (!topStatus || topStatus.querySelector(".recommendation-trigger")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "recommendation-trigger";
  button.dataset.recommendationAction = "open";
  button.innerHTML = '<i></i> 매수추천';
  topStatus.insertBefore(button, topStatus.firstChild);
}

const app = document.querySelector("#app");
if (app) {
  new MutationObserver(ensureTrigger).observe(app, { childList: true, subtree: true });
  ensureTrigger();
}

async function load({ force = false } = {}) {
  if (loading) return;
  loading = true;
  render();
  try {
    const response = await fetch(force ? REFRESH_ENDPOINT : ENDPOINT, {
      method: force ? "POST" : "GET",
      headers: { Accept: "application/json" },
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `추천 조회 실패 (${response.status})`);
    payload = result;
  } catch (error) {
    payload = {
      state: "ERROR",
      candidates: [],
      errors: [{ message: error instanceof Error ? error.message : "추천 조회 실패" }],
      status: { dataSources: {} },
    };
  } finally {
    loading = false;
    render();
  }
}

function openPanel() {
  overlay.hidden = false;
  document.body.classList.add("recommendation-open");
  void load();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => void load(), 15_000);
}

function closePanel() {
  overlay.hidden = true;
  document.body.classList.remove("recommendation-open");
  clearInterval(pollTimer);
  pollTimer = null;
}

function render() {
  if (overlay.hidden) return;
  const candidates = filteredCandidates();
  const status = payload?.status ?? {};
  const settings = payload?.settings ?? {};
  const cost = settings.costModel ?? {};
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  overlay.querySelector(".recommendation-panel").innerHTML = `
    <header class="recommendation-header">
      <div class="recommendation-title"><span>MARKET CANDIDATE SCANNER</span><h2>매수추천 리스트</h2><p>거래대금·등락률·체결강도 순위에서 후보를 찾고, 호가와 당일 분봉으로 반전형·눌림목형을 점수화합니다.</p></div>
      <div class="recommendation-actions"><button type="button" data-recommendation-action="refresh" ${loading ? "disabled" : ""}>${loading ? "조회 중" : "새로고침"}</button><button type="button" class="recommendation-close" data-recommendation-action="close" aria-label="닫기">×</button></div>
    </header>
    <div class="recommendation-summary">
      ${summary("상태", stateLabel(payload?.state), loading ? "KIS 데이터 조회 중" : "15초 캐시")}
      ${summary("1차 후보", fmt(payload?.universeCount), "순위 API 통합")}
      ${summary("정밀 분석", fmt(payload?.enrichedCount), "현재가·호가·분봉")}
      ${summary("목표 순수익", `${fmtDecimal(cost.targetNetProfitPercent, 2)}%`, "비용 추정 포함")}
      ${summary("실시간 확정", status.dataSources?.kis?.realtimeConfirmationAvailable ? "연결" : "미연결", "WebSocket 전환 필요")}
      ${summary("보조 데이터", auxiliarySourceLabel(status.dataSources), "DART·뉴스·커뮤니티")}
    </div>
    <div class="recommendation-source-warning">현재 목록은 KIS REST 스냅샷 기반 1차 후보입니다. ${auxiliarySourceDescription(status.dataSources)} 실시간 체결·호가 WebSocket 확인 전에는 자동매수 대상이 아니며, 수수료·세금 값은 계좌별 실제 정산과 대사해야 합니다.</div>
    ${errors.length ? `<div class="recommendation-error">${errors.slice(0, 3).map((item) => escapeHtml(item.message)).join(" · ")}</div>` : ""}
    <div class="recommendation-toolbar"><div class="recommendation-filters">${filterButton("ALL", "전체")}${filterButton("PULLBACK", "눌림목형")}${filterButton("REVERSAL", "반전형")}${filterButton("BLOCKED", "차단")}</div><span class="recommendation-updated">${updatedLabel(payload?.generatedAt)}</span></div>
    <div class="recommendation-table-wrap"><div class="recommendation-table">
      <div class="recommendation-head"><span>순위</span><span>상태</span><span>종목</span><span>유형</span><span>점수</span><span>현재가</span><span>등락률</span><span>목표가</span><span>근거·차단사유</span><span>메인</span></div>
      ${loading && !payload ? '<div class="recommendation-empty">KIS 추천 데이터를 불러오는 중입니다.</div>' : candidates.length ? candidates.map(row).join("") : '<div class="recommendation-empty">현재 조건을 충족하는 정밀 분석 후보가 없습니다.</div>'}
    </div></div>`;
}

function filteredCandidates() {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  if (activeFilter === "ALL") return candidates;
  if (activeFilter === "BLOCKED") return candidates.filter((item) => item.stage === "BLOCKED");
  return candidates.filter((item) => item.candidateType === activeFilter && item.stage !== "BLOCKED");
}

function row(item) {
  const change = Number(item.changePercent ?? 0);
  const reason = item.stage === "BLOCKED"
    ? (item.blockReasons ?? []).join(" · ")
    : (item.reasons ?? []).slice(0, 2).join(" · ");
  const auxiliary = item.auxiliary ?? {};
  const disclosureCount = Number(auxiliary.disclosure?.count ?? 0);
  const newsCount = Number(auxiliary.news?.total ?? 0);
  const communityCount = Number(auxiliary.community?.total ?? 0);
  const latestNews = auxiliary.news?.items?.[0]?.title;
  return `<div class="recommendation-row">
    <span class="recommendation-rank">${fmt(item.rank)}</span>
    <span class="recommendation-stage stage-${String(item.stage).toLowerCase().replaceAll("_", "-")}">${stageLabel(item.stage)}</span>
    <span class="recommendation-name"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.symbol)} · ${formatWon(item.accumulatedTradingValue)}</span></span>
    <span class="recommendation-type type-${String(item.candidateType).toLowerCase()}">${typeLabel(item.candidateType)}</span>
    <span class="recommendation-score"><strong>${fmt(item.score)}</strong><span>/100</span></span>
    <strong>${formatPrice(item.currentPrice)}</strong>
    <strong class="recommendation-change ${change >= 0 ? "positive" : "negative"}">${signed(change, 2)}%</strong>
    <span>${formatPrice(item.target?.targetPrice)}</span>
    <span class="recommendation-reasons"><b>${escapeHtml(reason || "근거 데이터 부족")}</b>스프레드 ${fmtDecimal(item.microstructure?.spreadTicks, 1)}틱 · 데이터 ${fmt(item.dataCompleteness?.percent)}% · 공시 ${fmt(disclosureCount)} · 뉴스 ${fmt(newsCount)} · 커뮤니티 ${fmt(communityCount)}${latestNews ? `<br>${escapeHtml(latestNews)}` : ""}</span>
    <button type="button" class="recommendation-select" data-recommendation-action="select" data-symbol="${escapeHtml(item.symbol)}">메인에서 보기</button>
  </div>`;
}

async function selectInstrument(symbol) {
  const response = await fetch("/api/instruments/select", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ symbol }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "종목 전환 실패");
  closePanel();
}

function filterButton(value, label) {
  return `<button type="button" class="recommendation-filter ${activeFilter === value ? "active" : ""}" data-recommendation-action="filter" data-filter="${value}">${label}</button>`;
}

function summary(label, value, detail) {
  return `<div><span>${label}</span><strong>${value}</strong><small>${detail}</small></div>`;
}

function auxiliarySourceLabel(dataSources = {}) {
  const count = [dataSources.dart?.enabled, dataSources.news?.enabled, dataSources.community?.enabled].filter(Boolean).length;
  return `${count}/3 연결`;
}
function auxiliarySourceDescription(dataSources = {}) {
  const missing = [];
  if (!dataSources.dart?.enabled) missing.push("DART");
  if (!dataSources.news?.enabled) missing.push("뉴스");
  if (!dataSources.community?.enabled) missing.push("커뮤니티");
  return missing.length ? `${missing.join("·")} API는 키 미설정으로 비활성입니다.` : "DART·뉴스·커뮤니티 보조 데이터가 연결돼 있습니다.";
}
function stateLabel(value) {
  return ({ READY: "준비", REFRESHING: "조회 중", ERROR: "오류", EMPTY: "후보 없음", DISABLED: "비활성", STALE: "갱신 필요" })[value] ?? String(value ?? "-");
}
function stageLabel(value) {
  return ({ CONFIRMATION_REQUIRED: "실시간 확인", WATCH: "감시", LOW_PRIORITY: "낮은 우선", BLOCKED: "차단" })[value] ?? String(value ?? "-");
}
function typeLabel(value) { return value === "PULLBACK" ? "눌림목" : value === "REVERSAL" ? "반전" : "-"; }
function fmt(value) { return Math.round(Number(value) || 0).toLocaleString("ko-KR"); }
function fmtDecimal(value, digits = 1) { const number = Number(value); return Number.isFinite(number) ? number.toFixed(digits) : "-"; }
function signed(value, digits) { const number = Number(value) || 0; return `${number >= 0 ? "+" : ""}${number.toFixed(digits)}`; }
function formatPrice(value) { return Number.isFinite(Number(value)) ? `${fmt(value)}원` : "-"; }
function formatWon(value) { const number = Number(value) || 0; if (number >= 1e12) return `${(number / 1e12).toFixed(1)}조`; if (number >= 1e8) return `${(number / 1e8).toFixed(0)}억`; return `${fmt(number)}원`; }
function updatedLabel(value) { return value ? `갱신 ${new Date(value).toLocaleTimeString("ko-KR", { hour12: false })}` : "아직 갱신되지 않음"; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }

document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-recommendation-action]");
  const action = target?.dataset.recommendationAction;
  if (action === "open") openPanel();
  if (action === "close") closePanel();
  if (action === "refresh") void load({ force: true });
  if (action === "filter") { activeFilter = target.dataset.filter ?? "ALL"; render(); }
  if (action === "select") {
    target.disabled = true;
    selectInstrument(target.dataset.symbol).catch((error) => {
      target.disabled = false;
      window.alert(error instanceof Error ? error.message : "종목 전환 실패");
    });
  }
});
overlay.addEventListener("click", (event) => { if (event.target === overlay) closePanel(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !overlay.hidden) closePanel(); });
