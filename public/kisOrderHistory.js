const app = document.querySelector("#app");

let latestSnapshot = null;
let latestSignature = "";
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

function statusLabel(status) {
  const labels = {
    FILLED: "전량체결",
    PARTIALLY_FILLED: "부분체결",
    PARTIALLY_FILLED_CANCELED: "부분체결 후 취소",
    OPEN: "미체결",
    CANCELED: "취소",
    REJECTED: "거절",
    ACCEPTED: "접수",
    UNKNOWN: "상태 확인 필요",
  };
  return labels[String(status ?? "").toUpperCase()] ?? String(status ?? "상태 확인 필요");
}

function statusClass(status) {
  const value = String(status ?? "").toUpperCase();
  if (new Set(["FILLED", "PARTIALLY_FILLED", "OPEN", "ACCEPTED"]).has(value)) return "status-ok";
  return "status-error";
}

function orderTypeText(order) {
  const name = String(order?.orderDivisionName ?? "").trim();
  if (name) return name;
  if (order?.type === "LIMIT") return `지정가 ${fmt(order.orderPrice)}원`;
  if (order?.type === "MARKET") return "시장가";
  return order?.orderPrice > 0 ? `주문가 ${fmt(order.orderPrice)}원` : "주문유형 확인 필요";
}

function findCancelableOrder(order, cancelableOrders) {
  if (!Array.isArray(cancelableOrders) || !order?.orderNumber) return null;
  return cancelableOrders.find((candidate) => (
    candidate.orderNumber === order.orderNumber
    && (!order.orderOrganizationNumber
      || candidate.orderOrganizationNumber === order.orderOrganizationNumber)
  )) ?? null;
}

function brokerOrderRow(order, cancelableOrders) {
  const side = String(order?.side ?? "").toUpperCase();
  const sideText = side === "BUY" ? "매수" : side === "SELL" ? "매도" : "주문";
  const sideClass = side === "BUY" ? "positive-text" : side === "SELL" ? "negative-text" : "";
  const orderQuantity = Number(order?.orderQuantity) || 0;
  const executedQuantity = Number(order?.executedQuantity) || 0;
  const remainingQuantity = Number(order?.remainingQuantity) || 0;
  const averageExecutedPrice = Number(order?.averageExecutedPrice) || 0;
  const executionText = executedQuantity > 0
    ? `${executedQuantity}/${orderQuantity}주 · 평균 ${fmt(averageExecutedPrice)}원`
    : `0/${orderQuantity}주 · 미체결 ${remainingQuantity || orderQuantity}주`;
  const cancelable = findCancelableOrder(order, cancelableOrders);
  const control = cancelable
    ? `<button class="cancel-order-button" data-action="cancel-order" data-order-number="${escapeHtml(cancelable.orderNumber)}" data-order-organization-number="${escapeHtml(cancelable.orderOrganizationNumber)}" data-cancel-quantity="${Number(cancelable.cancelableQuantity) || 0}">취소</button>`
    : "-";
  const title = [
    order?.name,
    order?.orderDate,
    order?.orderTime,
    order?.canceledQuantity ? `취소 ${order.canceledQuantity}주` : null,
    order?.rejectedQuantity ? `거절 ${order.rejectedQuantity}주` : null,
  ].filter(Boolean).join(" · ");
  return `<div class="order-row" title="${escapeHtml(title)}">
    <span class="${sideClass}">${sideText} ${orderQuantity}주</span>
    <span>${escapeHtml(orderTypeText(order))}</span>
    <span>${escapeHtml(order?.orderNumber ?? "-")} · ${escapeHtml(executionText)}</span>
    <span class="${statusClass(order?.status)}">${escapeHtml(statusLabel(order?.status))}</span>
    <span>${control}</span>
  </div>`;
}

function journalFallbackRow(command) {
  const request = command?.request ?? {};
  const response = command?.response ?? {};
  const result = response?.result ?? {};
  const operation = String(command?.operation ?? response?.operation ?? "SUBMIT").toUpperCase();
  const side = String(request?.side ?? "").toUpperCase();
  const quantity = Number(request?.quantity) || 0;
  const action = operation === "CANCEL"
    ? `취소 ${quantity}주`
    : operation === "REVISE"
      ? `정정 ${quantity}주`
      : `${side === "BUY" ? "매수" : "매도"} ${quantity}주`;
  const type = operation === "CANCEL"
    ? `원주문 ${request?.originalOrderNumber ?? "-"}`
    : request?.type === "LIMIT"
      ? `지정가 ${fmt(request?.limitPrice)}원`
      : "시장가";
  const status = String(response?.status ?? "ERROR").toUpperCase();
  const label = status === "ACCEPTED" ? "접수·체결조회 대기"
    : status === "PENDING" ? "전송 중"
      : status === "UNKNOWN_RESULT" ? "결과 불명"
        : status === "REJECTED" ? "거절" : "오류";
  return `<div class="order-row" title="KIS 주문·체결조회 실패로 실행 저널을 표시합니다.">
    <span>${escapeHtml(action)}</span>
    <span>${escapeHtml(type)}</span>
    <span>${escapeHtml(result?.orderNumber ?? request?.originalOrderNumber ?? "-")} · 체결조회 대기</span>
    <span class="${status === "ACCEPTED" ? "status-ok" : "status-error"}">${escapeHtml(label)}</span>
    <span>-</span>
  </div>`;
}

function snapshotSignature(snapshot) {
  const account = snapshot?.account ?? {};
  return JSON.stringify({
    fetchedAt: account.orderHistoryFetchedAt ?? null,
    historyError: account.orderHistoryError?.code ?? null,
    orders: Array.isArray(account.orders)
      ? account.orders.map((order) => [
        order.orderDate,
        order.orderOrganizationNumber,
        order.orderNumber,
        order.status,
        order.executedQuantity,
        order.remainingQuantity,
        order.canceledQuantity,
      ])
      : null,
    cancelable: Array.isArray(account.cancelableOrders)
      ? account.cancelableOrders.map((order) => [
        order.orderOrganizationNumber,
        order.orderNumber,
        order.cancelableQuantity,
      ])
      : [],
    commands: Array.isArray(account.commands)
      ? account.commands.map((command) => [command.id, command.response?.status])
      : [],
  });
}

function renderOrderHistory() {
  scheduled = false;
  if (!latestSnapshot || stopped) return;
  const account = latestSnapshot.account ?? {};
  const list = app?.querySelector(".orders-list");
  const note = app?.querySelector(".execution-note");
  if (!list || !note) return;
  if (list.dataset.kisOrderHistorySignature === latestSignature) return;

  const historyLoaded = account.orderHistoryFetchedAt !== null
    && account.orderHistoryFetchedAt !== undefined
    && Number.isFinite(Number(account.orderHistoryFetchedAt));
  const orders = Array.isArray(account.orders) ? account.orders : [];
  const cancelableOrders = Array.isArray(account.cancelableOrders) ? account.cancelableOrders : [];
  const historyError = account.orderHistoryError?.message ?? null;
  const commands = Array.isArray(account.commands) ? account.commands : [];
  const rows = historyLoaded && !historyError
    ? orders.slice(0, 30).map((order) => brokerOrderRow(order, cancelableOrders))
    : commands.slice(0, 30).map(journalFallbackRow);
  const emptyText = historyLoaded && !historyError
    ? "오늘 KIS 주문·체결내역이 없습니다."
    : "KIS 체결내역을 불러오지 못했고 실행 저널에도 주문 명령이 없습니다.";

  list.innerHTML = `<div class="table-head"><span>주문</span><span>유형·가격</span><span>주문번호·체결</span><span>상태</span><span>제어</span></div>${rows.join("") || `<div class="empty-list">${escapeHtml(emptyText)}</div>`}`;
  list.dataset.kisOrderHistorySignature = latestSignature;
  note.innerHTML = historyLoaded && !historyError
    ? "주문 전 최종 확인을 거칩니다. 목록은 KIS 모의계좌의 당일 주문·체결조회 결과입니다. 체결수량·평균체결가·미체결·취소 상태를 증권사 기준으로 표시합니다."
    : `KIS 주문·체결조회에 실패해 서버 실행 저널을 임시 표시합니다. ACCEPTED는 증권사 주문 접수이며 체결 완료가 아닙니다.${historyError ? ` · ${escapeHtml(historyError)}` : ""}`;
}

function scheduleRender() {
  if (scheduled || stopped) return;
  scheduled = true;
  queueMicrotask(renderOrderHistory);
}

async function refreshSnapshot() {
  try {
    const response = await fetch("/api/snapshot", { headers: { Accept: "application/json" } });
    if (!response.ok) return;
    const snapshot = await response.json();
    const signature = snapshotSignature(snapshot);
    latestSnapshot = snapshot;
    latestSignature = signature;
    scheduleRender();
  } catch {
    // 메인 화면의 연결 상태 표시를 방해하지 않습니다.
  }
}

const observer = new MutationObserver(scheduleRender);
if (app) observer.observe(app, { childList: true });

const interval = setInterval(refreshSnapshot, 2_000);
window.addEventListener("focus", refreshSnapshot);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshSnapshot();
});
app?.addEventListener("click", (event) => {
  if (event.target.closest('[data-action="refresh"]')) setTimeout(refreshSnapshot, 500);
});
window.addEventListener("pagehide", () => {
  stopped = true;
  clearInterval(interval);
  observer.disconnect();
}, { once: true });

void refreshSnapshot();
