const app = document.querySelector("#app");
const LIVE_COMMANDS_KEY = "pulsehft.kisLiveCommands";
const CANARY_QUANTITY = 1;

let liveStatus = null;
let market = null;
let busy = false;
let orderType = "MARKET";
let limitPrice = null;
let message = null;
let lastSymbol = null;
let commands = readStoredCommands();
let scheduled = false;
let stopped = false;

const fmt = (value) => Math.round(Number(value) || 0).toLocaleString("ko-KR");
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&quot;",
})[char]);

injectStyles();

function injectStyles() {
  if (document.querySelector("#kis-live-order-styles")) return;
  const style = document.createElement("style");
  style.id = "kis-live-order-styles";
  style.textContent = `
    .kis-live-panel{margin-top:12px;padding:16px 18px;border:1px solid #7a2f3a;border-radius:12px;background:linear-gradient(180deg,#1c0d10,#120a0d)}
    .kis-live-panel .panel-title-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px}
    .kis-live-panel .eyebrow{color:#ff8fa3;letter-spacing:.08em}
    .kis-live-panel h3{margin:2px 0 0;color:#ffd9df;font-size:15px}
    .kis-live-warning{font-size:10px;color:#ffb7c8;background:#2a1017;border:1px solid #6f3348;border-radius:7px;padding:6px 10px;display:inline-block;margin-top:4px}
    .kis-live-account-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
    .kis-live-account-grid div{background:#160b0e;border:1px solid #3a1e24;border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:2px}
    .kis-live-account-grid span{font-size:9px;color:#a67783}
    .kis-live-account-grid strong{font-size:13px;color:#ffe3e8}
    .kis-live-order-entry{display:grid;grid-template-columns:130px 90px 160px 1fr;gap:10px;align-items:end;margin-bottom:10px}
    .kis-live-order-entry label{display:flex;flex-direction:column;gap:4px;font-size:10px;color:#c99;}
    .kis-live-order-entry input,.kis-live-order-entry select{background:#0e0709;border:1px solid #4a262d;border-radius:6px;color:#fdecef;padding:6px 8px;font-size:12px}
    .kis-live-quantity-fixed{background:#0e0709;border:1px solid #4a262d;border-radius:6px;color:#ffb7c8;padding:6px 8px;font-size:12px;text-align:center}
    .kis-live-order-buttons{display:flex;gap:8px}
    .kis-live-buy,.kis-live-sell{flex:1;padding:9px 10px;border-radius:7px;border:none;font-size:12px;font-weight:700;cursor:pointer}
    .kis-live-buy{background:#7a2030;color:#ffe3e8}
    .kis-live-sell{background:#3a2a2a;color:#ffe3e8;border:1px solid #7a2030}
    .kis-live-buy:disabled,.kis-live-sell:disabled{opacity:.4;cursor:not-allowed}
    .kis-live-risk-list{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:10px;font-size:10px;color:#c99}
    .kis-live-risk-list strong{display:block;color:#ffe3e8;font-size:12px}
    .kis-live-kill-row{display:flex;justify-content:space-between;align-items:center;margin:10px 0;padding:8px 10px;border:1px solid #4a262d;border-radius:8px;background:#160b0e}
    .kis-live-kill-row button{padding:5px 12px;border-radius:14px;border:1px solid #7a2030;background:#2a1017;color:#ffb7c8;font-size:10px;cursor:pointer}
    .kis-live-kill-row button.on{background:#7a2030;color:#fff}
    .kis-live-disabled-note{font-size:10px;color:#a67783;margin-top:4px}
    .kis-live-orders{margin-top:10px;font-size:10px;color:#e0b8bf}
    .kis-live-orders .row{display:grid;grid-template-columns:1.2fr 1fr 1fr .8fr;gap:6px;padding:4px 0;border-top:1px solid #3a1e24}
    .kis-live-cancel-form{display:grid;grid-template-columns:1fr 1fr 90px auto;gap:8px;margin-top:10px;align-items:end}
    .kis-live-cancel-form label{display:flex;flex-direction:column;gap:4px;font-size:10px;color:#c99}
    .kis-live-cancel-form input{background:#0e0709;border:1px solid #4a262d;border-radius:6px;color:#fdecef;padding:6px 8px;font-size:12px}
    .kis-live-cancel-form button{padding:7px 12px;border-radius:6px;border:1px solid #7a2030;background:#2a1017;color:#ffb7c8;font-size:11px;cursor:pointer}
    .kis-live-unknown{margin-top:10px;padding:8px 10px;border:1px solid #6f3348;border-radius:8px;background:#211019;color:#ffb7c8;font-size:10px}
  `;
  document.head.append(style);
}

function createClientOrderId(operation) {
  if (globalThis.crypto?.randomUUID) return `live-${operation.toLowerCase()}-${crypto.randomUUID()}`;
  return `live-${operation.toLowerCase()}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readStoredCommands() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LIVE_COMMANDS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.slice(0, 20) : [];
  } catch {
    return [];
  }
}

function writeStoredCommands() {
  try { localStorage.setItem(LIVE_COMMANDS_KEY, JSON.stringify(commands.slice(0, 20))); } catch {
    // localStorage가 차단돼도 현재 세션 기록은 유지합니다.
  }
}

function upsertCommand(entry) {
  commands = [entry, ...commands.filter((item) => item.id !== entry.id)].slice(0, 20);
  writeStoredCommands();
}

async function request(path, body, { method = "POST" } = {}) {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? `요청 실패 (${response.status})`);
  return result;
}

function nullableMoney(value) {
  if (value === null || value === undefined || value === "") return "-";
  return Number.isFinite(Number(value)) ? `${fmt(value)}원` : "-";
}

function commandRow(command) {
  const req = command.request ?? {};
  const res = command.response ?? {};
  const brokerResult = res.result ?? {};
  const status = res.status ?? "ERROR";
  const operation = String(command.operation ?? res.operation ?? "SUBMIT").toUpperCase();
  const side = String(req.side ?? "").toUpperCase();
  const actionText = operation === "CANCEL"
    ? `취소`
    : operation === "REVISE"
      ? `정정`
      : `${side === "BUY" ? "매수" : "매도"} ${Number(req.quantity) || 0}주`;
  return `<div class="row">
    <span>${escapeHtml(actionText)}</span>
    <span>${escapeHtml(brokerResult.orderNumber ?? req.originalOrderNumber ?? "-")}</span>
    <span>${new Date(command.at).toLocaleTimeString("ko-KR", { hour12: false })}</span>
    <span>${escapeHtml(status)}</span>
  </div>`;
}

function render() {
  scheduled = false;
  if (!app || stopped) return;

  const existing = app.querySelector(".kis-live-panel");
  const enabled = Boolean(liveStatus?.enabled);
  const hasOrderService = Boolean(liveStatus?.orderApiAvailable);

  if (!enabled) {
    existing?.remove();
    return;
  }

  const executionGrid = app.querySelector(".execution-grid");
  if (!executionGrid) return;

  const service = liveStatus.service ?? {};
  const killSwitch = Boolean(service.killSwitch);
  const limits = service.limits ?? {};
  const unknownCommands = Array.isArray(service.unknownCommands) ? service.unknownCommands : [];
  const disabled = busy || killSwitch || !hasOrderService ? "disabled" : "";
  const limitDisabled = orderType === "MARKET" ? "disabled" : "";
  const symbol = market?.symbol ?? "-";
  const symbolName = market?.symbolName ?? "-";
  const lastPrice = market?.lastPrice ?? 0;
  const tickSize = market?.tickSize ?? 100;
  if (lastSymbol !== symbol) {
    lastSymbol = symbol;
    limitPrice = lastPrice;
  } else if (limitPrice === null) {
    limitPrice = lastPrice;
  }
  const balance = liveBalanceSummary();

  const panel = existing ?? document.createElement("div");
  panel.className = "kis-live-panel";
  panel.innerHTML = `
    <div class="panel-title-row">
      <div><span class="eyebrow">⚠ KIS LIVE ACCOUNT — 실전투자(REAL MONEY)</span><h3>실전 카나리 수동 주문</h3><div class="kis-live-warning">실제 계좌 자금으로 체결됩니다. 카나리 단계는 주문당 정확히 ${CANARY_QUANTITY}주로 고정됩니다.</div></div>
      <button class="ghost-button" data-live-action="refresh" ${busy ? "disabled" : ""}>새로고침</button>
    </div>
    ${!hasOrderService ? `<div class="kis-live-disabled-note">주문 제출이 비활성화되어 있습니다. PULSEHFT_KIS_LIVE_ORDER_ENABLED=true로 재시작해야 주문·정정·취소가 가능합니다(잔고 조회는 가능).</div>` : ""}
    <div class="kis-live-account-grid">
      <div><span>총평가금액</span><strong>${nullableMoney(balance.totalEvaluationAmount)}</strong></div>
      <div><span>가용현금</span><strong>${nullableMoney(balance.cash)}</strong></div>
      <div><span>평가손익</span><strong>${nullableMoney(balance.evaluationProfitLoss)}</strong></div>
      <div><span>종목</span><strong>${escapeHtml(symbol)} ${escapeHtml(symbolName)}</strong></div>
    </div>
    <div class="kis-live-order-entry">
      <label>주문 유형<select id="live-order-type"><option value="MARKET" ${orderType === "MARKET" ? "selected" : ""}>시장가</option><option value="LIMIT" ${orderType === "LIMIT" ? "selected" : ""}>지정가</option></select></label>
      <label>수량(카나리 고정)<div class="kis-live-quantity-fixed">${CANARY_QUANTITY}주</div></label>
      <label>지정 가격<input id="live-limit-price" type="number" min="1" step="${tickSize}" value="${limitPrice}" ${limitDisabled}></label>
      <div class="kis-live-order-buttons"><button class="kis-live-buy" data-live-action="buy" ${disabled}>실전 매수 (REAL)</button><button class="kis-live-sell" data-live-action="sell" ${disabled}>실전 매도 (REAL)</button></div>
    </div>
    <div class="kis-live-kill-row"><div><strong>킬 스위치</strong><span> · 실전 신규·정정 주문 즉시 차단(취소는 계속 허용)</span></div><button class="${killSwitch ? "on" : ""}" data-live-action="kill" ${busy || !hasOrderService ? "disabled" : ""}>${killSwitch ? "켜짐" : "꺼짐"}</button></div>
    <div class="kis-live-risk-list">
      <div><span>1회 최대</span><strong>${fmt(limits.maxOrderQuantity ?? CANARY_QUANTITY)}주</strong></div>
      <div><span>최대 주문금액</span><strong>${fmt((limits.maxOrderValue ?? 0) / 10000)}만원</strong></div>
      <div><span>일일 주문</span><strong>${fmt(limits.maxDailyOrders ?? 0)}건</strong></div>
      <div><span>일일 손실 제한</span><strong>-${fmt((limits.maxDailyLoss ?? 0) / 10000)}만원</strong></div>
      <div><span>연속 손실 제한</span><strong>${fmt(limits.maxConsecutiveLosses ?? 0)}회</strong></div>
      <div><span>오늘 주문 건수</span><strong>${fmt(service.todayCommandCount ?? 0)}건</strong></div>
    </div>
    ${unknownCommands.length > 0 ? `<div class="kis-live-unknown">주문 결과 불명 ${unknownCommands.length}건 — 실계좌 주문내역과 직접 대조한 뒤 <code>/api/kis/live/orders/resolve-unknown</code>으로 접수·미접수를 확정해야 킬 스위치 해제가 가능합니다. 자세한 절차는 docs/KIS_LIVE_TRADING.md 참고.</div>` : ""}
    <div class="kis-live-cancel-form">
      <label>원주문번호<input id="live-cancel-order-number" type="text" placeholder="예: 0000012345"></label>
      <label>주문조직번호<input id="live-cancel-org-number" type="text" placeholder="예: 91234"></label>
      <label>수량<input id="live-cancel-quantity" type="number" min="1" value="${CANARY_QUANTITY}"></label>
      <button data-live-action="cancel" ${busy || !hasOrderService ? "disabled" : ""}>주문 취소</button>
    </div>
    <div class="kis-live-orders">${commands.slice(0, 8).map(commandRow).join("") || '<div>제출한 실전 주문 명령이 아직 없습니다(이 브라우저 기록 기준).</div>'}</div>
  `;
  // app.js가 execution-grid를 다시 그릴 때마다 이 패널을 일단 그리드 안으로
  // 옮겨 붙여 놓으므로(파괴 방지용 임시 조치), 매 렌더마다 원래 자리(그리드
  // 바로 다음 형제, 전체 너비)로 스스로 되돌린다.
  if (executionGrid.nextElementSibling !== panel) executionGrid.insertAdjacentElement("afterend", panel);

  if (message) {
    let toast = app.querySelector(".kis-live-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "toast kis-live-toast";
      toast.dataset.liveAction = "dismiss-message";
      panel.insertAdjacentElement("beforebegin", toast);
    }
    toast.textContent = message;
  } else {
    app.querySelector(".kis-live-toast")?.remove();
  }
}

let lastBalance = null;
function liveBalanceSummary() {
  return lastBalance?.summary ?? {};
}

function scheduleRender() {
  if (scheduled || stopped) return;
  scheduled = true;
  queueMicrotask(render);
}

async function refresh() {
  try {
    const status = await request("/api/kis/live/status", null, { method: "GET" });
    liveStatus = status;
    if (status?.enabled && status?.orderApiAvailable) {
      try { lastBalance = await request("/api/kis/live/balance", null, { method: "GET" }); } catch { lastBalance = null; }
    } else {
      lastBalance = null;
    }
  } catch {
    liveStatus = null;
  }
  try {
    const snap = await request("/api/snapshot", null, { method: "GET" });
    market = { symbol: snap.symbol, symbolName: snap.symbolName, lastPrice: snap.lastPrice, tickSize: snap.tickSize };
  } catch {
    // 메인 화면 연결 상태를 방해하지 않습니다.
  }
  scheduleRender();
}

function orderRequest(side) {
  const body = {
    side,
    symbol: market?.symbol,
    type: orderType,
    quantity: CANARY_QUANTITY,
    exchange: "KRX",
    clientOrderId: createClientOrderId(side),
  };
  if (orderType === "LIMIT") body.limitPrice = limitPrice;
  else body.referencePrice = market?.lastPrice;
  return body;
}

async function run(action, { recordEntry = null } = {}) {
  try {
    busy = true;
    message = null;
    render();
    const result = await action();
    if (recordEntry) {
      upsertCommand({
        id: recordEntry.clientOrderId,
        at: Date.now(),
        operation: result?.operation ?? recordEntry.operation ?? "SUBMIT",
        request: recordEntry,
        response: result,
      });
    }
    if (result?.status === "REJECTED") message = `실전주문 거절: ${result.error?.message ?? "증권사 거절"}`;
    else if (result?.status === "UNKNOWN_RESULT") message = "실전주문 결과가 불명확합니다. 반드시 실계좌 주문내역과 대조하세요.";
    else if (result?.status === "ACCEPTED") message = "실전주문이 증권사에 접수됐습니다. 실제 체결 여부는 별도로 확인해야 합니다.";
  } catch (error) {
    message = error instanceof Error ? error.message : "요청 처리 중 오류가 발생했습니다.";
  } finally {
    busy = false;
    await refresh();
  }
}

async function submit(side) {
  const body = orderRequest(side);
  if (!body.symbol) { message = "현재 선택된 종목 정보를 불러오지 못했습니다."; render(); return; }
  const priceText = body.type === "MARKET" ? `시장가 · 기준가 ${fmt(body.referencePrice)}원` : `지정가 ${fmt(body.limitPrice)}원`;
  const confirmed = window.confirm(
    `⚠ 실전 계좌(REAL MONEY) ${side === "BUY" ? "매수" : "매도"} 주문을 전송합니다.\n`
    + `${body.symbol} ${market?.symbolName ?? ""}\n${body.quantity}주 · ${priceText}\n\n`
    + `이것은 모의투자가 아니라 실제 자금이 체결되는 주문입니다. 계속하시겠습니까?`,
  );
  if (!confirmed) return;
  await run(() => request("/api/kis/live/orders", body), { recordEntry: { ...body, operation: "SUBMIT" } });
}

async function cancel() {
  const originalOrderNumber = document.querySelector("#live-cancel-order-number")?.value.trim();
  const orderOrganizationNumber = document.querySelector("#live-cancel-org-number")?.value.trim();
  const quantity = Number(document.querySelector("#live-cancel-quantity")?.value) || CANARY_QUANTITY;
  if (!originalOrderNumber || !orderOrganizationNumber) {
    message = "취소하려면 원주문번호와 주문조직번호가 모두 필요합니다.";
    render();
    return;
  }
  const body = {
    clientOrderId: createClientOrderId("cancel"),
    originalOrderNumber,
    orderOrganizationNumber,
    quantity,
    exchange: "KRX",
    allQuantity: true,
  };
  const confirmed = window.confirm(`실전 주문 ${originalOrderNumber}의 취소 가능 수량 ${quantity}주를 전부 취소할까요?`);
  if (!confirmed) return;
  await run(() => request("/api/kis/live/orders/cancel", body), { recordEntry: { ...body, side: "CANCEL", operation: "CANCEL" } });
}

app?.addEventListener("input", (event) => {
  if (event.target.id === "live-limit-price") limitPrice = Math.max(1, Number(event.target.value) || 1);
});

app?.addEventListener("change", (event) => {
  if (event.target.id === "live-order-type") {
    orderType = event.target.value;
    if (orderType === "LIMIT" && !limitPrice) limitPrice = market?.lastPrice ?? 1;
    render();
  }
});

app?.addEventListener("click", (event) => {
  const target = event.target.closest("[data-live-action]");
  const action = target?.dataset.liveAction;
  if (!action) return;
  if (action === "dismiss-message") { message = null; render(); }
  if (action === "refresh") void refresh();
  if (action === "buy") void submit("BUY");
  if (action === "sell") void submit("SELL");
  if (action === "cancel") void cancel();
  if (action === "kill") {
    const nextEnabled = !liveStatus?.service?.killSwitch;
    void run(() => request("/api/kis/live/kill-switch", { enabled: nextEnabled }));
  }
});

const observer = new MutationObserver(scheduleRender);
if (app) observer.observe(app, { childList: true });
const interval = setInterval(refresh, 2_000);
window.addEventListener("focus", refresh);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
});
window.addEventListener("pagehide", () => {
  stopped = true;
  clearInterval(interval);
  observer.disconnect();
}, { once: true });

void refresh();
