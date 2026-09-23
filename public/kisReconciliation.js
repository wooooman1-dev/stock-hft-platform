const app = document.querySelector("#app");

let reconciliation = null;
let unknownCommands = [];
let signature = "";
let scheduled = false;
let stopped = false;

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&quot;",
})[char]);

injectStyles();

function injectStyles() {
  if (document.querySelector("#kis-reconciliation-styles")) return;
  const style = document.createElement("style");
  style.id = "kis-reconciliation-styles";
  style.textContent = `
    .kis-reconciliation-card{margin:8px 0 4px;padding:11px 12px;border:1px solid #26364d;border-radius:9px;background:#0a121e;display:flex;justify-content:space-between;align-items:center;gap:12px}
    .kis-reconciliation-card>div{display:flex;flex-direction:column;gap:3px;min-width:0}
    .kis-reconciliation-card span{font-size:9px;color:#65758b}
    .kis-reconciliation-card strong{font-size:12px;color:#79dfc0}
    .kis-reconciliation-card small{font-size:9px;color:#56667c;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .kis-reconciliation-card.pending{border-color:#66542d;background:#17150f}.kis-reconciliation-card.pending strong{color:#ffd567}
    .kis-reconciliation-card.danger{border-color:#6f3348;background:#211019}.kis-reconciliation-card.danger strong{color:#ff91aa}
    .kis-reconciliation-counts{display:grid!important;grid-template-columns:repeat(3,auto);gap:4px 10px!important;text-align:right;flex:none}
    .kis-reconciliation-counts b{font-size:10px;color:#9fb0c8;font-weight:700}
    .kis-reconciliation-banner{margin-top:10px;padding:12px 14px;border:1px solid #6f3348;border-radius:10px;background:#211019;color:#ffb7c8;font-size:11px;line-height:1.55}
    .kis-reconciliation-banner.pending{border-color:#66542d;background:#17150f;color:#ffe19a}
    .kis-reconciliation-banner strong{display:block;margin-bottom:5px;font-size:12px}
    .kis-reconciliation-banner ul{margin:5px 0 0;padding-left:18px}.kis-reconciliation-banner li{margin:2px 0}
    .kis-reconciliation-banner p{margin:7px 0 0;color:#ffd0dc}
    .kis-reconciliation-banner code{font-size:10px;color:#ffe19a}
  `;
  document.head.append(style);
}

function statusMeta(value) {
  const status = String(value?.status ?? "DISABLED").toUpperCase();
  if (status === "CONSISTENT") {
    return { label: "계좌 대조 정상", detail: "실행 저널·KIS 주문내역·보유수량 일치", className: "" };
  }
  if (status === "RESOLVED_AWAITING_ACK") {
    return { label: "불일치 해소 · 사용자 확인 필요", detail: "킬 스위치를 끄면 대조 확인이 실행 저널에 기록됩니다.", className: "pending" };
  }
  if (status === "PENDING") {
    return { label: "KIS 주문 반영 대기", detail: "증권사 반영이 끝날 때까지 추가 신규·정정 주문이 차단됩니다.", className: "pending" };
  }
  if (status === "MISMATCH") {
    return { label: "계좌 불일치 감지", detail: "신규·정정 주문이 차단됐으며 취소 주문만 허용됩니다.", className: "danger" };
  }
  if (status === "UNAVAILABLE") {
    return { label: "계좌 대조 불가", detail: "KIS 주문내역과 잔고를 모두 확인할 때까지 주문이 차단됩니다.", className: "danger" };
  }
  return { label: "계좌 대조 비활성", detail: "KIS 모의투자 대조 기능이 비활성화되어 있습니다.", className: "" };
}

function unknownResolutionHint(commands) {
  if (!Array.isArray(commands) || commands.length === 0) return "";
  const ids = commands
    .map((command) => String(command?.clientOrderId ?? "").trim())
    .filter(Boolean)
    .slice(0, 5)
    .join(", ");
  return `<p>주문 결과 불명 ${commands.length}건(${escapeHtml(ids)})은 KIS 모의계좌 주문내역과 직접 대조한 뒤 <code>npm run resolve:kis:paper-unknown</code>으로 접수·미접수를 확정해야 차단이 풀립니다.</p>`;
}

function issueMessages(value) {
  const issues = Array.isArray(value?.issues) ? value.issues : [];
  const pending = Array.isArray(value?.pending) ? value.pending : [];
  return [...issues, ...pending]
    .map((item) => String(item?.message ?? "").trim())
    .filter(Boolean)
    .slice(0, 5);
}

function render() {
  scheduled = false;
  if (!app || stopped || !reconciliation) return;
  const status = String(reconciliation.status ?? "DISABLED").toUpperCase();
  const existingCard = app.querySelector(".kis-reconciliation-card");
  const existingBanner = app.querySelector(".kis-reconciliation-banner");
  if (status === "DISABLED") {
    existingCard?.remove();
    existingBanner?.remove();
    return;
  }
  const systemPanel = app.querySelector(".system-panel");
  if (!systemPanel) return;
  const meta = statusMeta(reconciliation);
  const summary = reconciliation.summary ?? {};
  const card = existingCard ?? document.createElement("div");
  card.className = `kis-reconciliation-card ${meta.className}`.trim();
  card.dataset.signature = signature;
  card.innerHTML = `
    <div><span>KIS ACCOUNT RECONCILIATION</span><strong>${escapeHtml(meta.label)}</strong><small>${escapeHtml(meta.detail)}</small></div>
    <div class="kis-reconciliation-counts">
      <span>저널 <b>${Number(summary.journalCommandCount) || 0}</b></span>
      <span>KIS 주문 <b>${Number(summary.brokerOrderCount) || 0}</b></span>
      <span>오류 <b>${Number(summary.issueCount) || 0}</b></span>
    </div>`;
  if (!existingCard) {
    const executionModel = systemPanel.querySelector(".execution-model");
    if (executionModel) executionModel.insertAdjacentElement("afterend", card);
    else systemPanel.prepend(card);
  }

  const blocked = Boolean(reconciliation.blocked);
  if (!blocked || status === "CONSISTENT") {
    existingBanner?.remove();
    return;
  }
  const messages = issueMessages(reconciliation);
  const banner = existingBanner ?? document.createElement("div");
  banner.className = `kis-reconciliation-banner ${meta.className === "pending" ? "pending" : ""}`.trim();
  banner.innerHTML = `<strong>${escapeHtml(meta.label)}</strong>${escapeHtml(meta.detail)}${messages.length > 0 ? `<ul>${messages.map((message) => `<li>${escapeHtml(message)}</li>`).join("")}</ul>` : ""}${unknownResolutionHint(unknownCommands)}`;
  if (!existingBanner) {
    const killBanner = app.querySelector(".kill-banner");
    const topbar = app.querySelector(".topbar");
    if (killBanner) killBanner.insertAdjacentElement("afterend", banner);
    else topbar?.insertAdjacentElement("afterend", banner);
  }
}

function scheduleRender() {
  if (scheduled || stopped) return;
  scheduled = true;
  queueMicrotask(render);
}

async function refresh() {
  try {
    const response = await fetch("/api/kis/paper/status", { headers: { Accept: "application/json" } });
    if (!response.ok) return;
    const payload = await response.json();
    const next = payload?.service?.reconciliation ?? null;
    const nextUnknownCommands = Array.isArray(payload?.service?.unknownCommands)
      ? payload.service.unknownCommands
      : [];
    const nextSignature = JSON.stringify({ next, nextUnknownCommands });
    reconciliation = next;
    unknownCommands = nextUnknownCommands;
    if (nextSignature !== signature) {
      signature = nextSignature;
      scheduleRender();
    }
  } catch {
    // 메인 화면의 KIS 연결 상태를 방해하지 않습니다.
  }
}

const observer = new MutationObserver(scheduleRender);
if (app) observer.observe(app, { childList: true });
const interval = setInterval(refresh, 2_000);
window.addEventListener("focus", refresh);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
});
app?.addEventListener("click", (event) => {
  if (event.target.closest('[data-action="refresh"], [data-action="kill"]')) {
    setTimeout(refresh, 700);
  }
});
window.addEventListener("pagehide", () => {
  stopped = true;
  clearInterval(interval);
  observer.disconnect();
}, { once: true });

void refresh();
