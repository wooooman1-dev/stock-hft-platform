const app = document.querySelector("#app");
const KIS_COMMANDS_KEY = "pulsehft.kisPaperCommands";

let snapshot = null;
let connection = "connecting";
let busy = false;
let quantity = 1;
let orderType = "MARKET";
let limitPrice = null;
let message = null;
let lastSymbol = null;
let kisCommands = readStoredCommands();

const fmt = (value) => Math.round(Number(value) || 0).toLocaleString("ko-KR");
const signed = (value, digits = 1) => `${value >= 0 ? "+" : ""}${Number(value || 0).toFixed(digits)}`;
const tone = (value) => value > 0.03 ? "positive" : value < -0.03 ? "negative" : "neutral";
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&quot;",
})[char]);

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

function priceChart(candles) {
  const data = Array.isArray(candles) ? candles.slice(-90) : [];
  if (data.length < 2) return '<div class="chart-empty">KIS 차트 데이터를 불러오는 중입니다.</div>';
  const width = 1000;
  const height = 360;
  const padding = { top: 24, right: 72, bottom: 30, left: 14 };
  const values = data.flatMap((item) => [item.high, item.low]).filter(Number.isFinite);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const y = (price) => padding.top + ((max - price) / range) * (height - padding.top - padding.bottom);
  const step = (width - padding.left - padding.right) / data.length;
  const candleWidth = Math.max(2, Math.min(8, step * 0.55));
  const grids = Array.from({ length: 5 }, (_, index) => max - range * index / 4)
    .map((price) => `<g><line x1="${padding.left}" x2="${width - padding.right}" y1="${y(price)}" y2="${y(price)}" class="chart-grid"/><text x="${width - padding.right + 8}" y="${y(price) + 4}" class="chart-label">${fmt(price)}</text></g>`)
    .join("");
  const path = data
    .map((item, index) => `${index ? "L" : "M"}${(padding.left + step * index + step / 2).toFixed(1)},${y(item.close).toFixed(1)}`)
    .join(" ");
  const bars = data.map((item, index) => {
    const x = padding.left + step * index + step / 2;
    const className = item.close >= item.open ? "candle-up" : "candle-down";
    const top = y(Math.max(item.open, item.close));
    const bottom = y(Math.min(item.open, item.close));
    return `<g class="${className}"><line x1="${x}" x2="${x}" y1="${y(item.high)}" y2="${y(item.low)}"/><rect x="${x - candleWidth / 2}" y="${top}" width="${candleWidth}" height="${Math.max(1.5, bottom - top)}" rx="1"/></g>`;
  }).join("");
  return `<svg class="price-chart" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="priceArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="rgba(99,216,255,.24)"/><stop offset="100%" stop-color="rgba(99,216,255,0)"/></linearGradient></defs>${grids}<path d="${path} L${width - padding.right},${height - padding.bottom} L${padding.left},${height - padding.bottom} Z" fill="url(#priceArea)"/><path d="${path}" class="chart-line"/>${bars}</svg>`;
}

function metric(label, value, detail, className = "neutral") {
  return `<div class="metric-card ${className}"><span>${label}</span><strong>${value}</strong><small>${detail}</small></div>`;
}

function bookRow(level, type, maxSize) {
  return `<div class="book-row ${type}"><div class="book-depth" style="width:${Math.max(4, level.size / maxSize * 100)}%"></div><span class="book-price">${fmt(level.price)}</span><span class="book-size">${fmt(level.size)}</span></div>`;
}

function createClientOrderId(operation) {
  if (globalThis.crypto?.randomUUID) return `ui-${operation.toLowerCase()}-${crypto.randomUUID()}`;
  return `ui-${operation.toLowerCase()}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function orderRequest(side) {
  const body = {
    side,
    symbol: snapshot.symbol,
    type: orderType,
    quantity,
    exchange: "KRX",
    clientOrderId: createClientOrderId(side),
  };
  if (orderType === "LIMIT") body.limitPrice = limitPrice;
  else body.referencePrice = snapshot.lastPrice;
  return body;
}

function commandStatusLabel(status) {
  if (status === "ACCEPTED") return "접수·체결 미확인";
  if (status === "UNKNOWN_RESULT") return "결과 불명";
  if (status === "REJECTED") return "거절";
  return status || "오류";
}

function commandRow(command) {
  const requestValue = command.request ?? {};
  const responseValue = command.response ?? {};
  const brokerResult = responseValue.result ?? {};
  const status = responseValue.status ?? "ERROR";
  const sideClass = requestValue.side === "BUY" ? "positive-text" : "negative-text";
  const statusClass = status === "ACCEPTED" ? "status-ok" : "status-error";
  const orderNumber = brokerResult.orderNumber ?? "-";
  const typeText = requestValue.type === "LIMIT"
    ? `지정가 ${fmt(requestValue.limitPrice)}`
    : "시장가";
  const cancelable = findCancelableOrder(brokerResult);
  const control = cancelable
    ? `<button class="cancel-order-button" data-action="cancel-order" data-order-number="${escapeHtml(cancelable.orderNumber)}" data-order-organization-number="${escapeHtml(cancelable.orderOrganizationNumber)}" data-cancel-quantity="${Number(cancelable.cancelableQuantity) || 0}">취소</button>`
    : "-";
  return `<div class="order-row" title="${escapeHtml(responseValue.error?.message ?? "ACCEPTED는 실제 체결 완료를 의미하지 않습니다.")}">
    <span class="${sideClass}">${requestValue.side === "BUY" ? "매수" : "매도"} ${Number(requestValue.quantity) || 0}주</span>
    <span>${typeText}</span>
    <span>${escapeHtml(orderNumber)} · 체결 미확인</span>
    <span class="${statusClass}">${commandStatusLabel(status)}</span>
    <span>${control}</span>
  </div>`;
}

function findCancelableOrder(result) {
  const orders = snapshot?.account?.cancelableOrders;
  if (!Array.isArray(orders) || !result?.orderNumber) return null;
  return orders.find((order) => (
    order.orderNumber === result.orderNumber
    && (!result.orderOrganizationNumber
      || order.orderOrganizationNumber === result.orderOrganizationNumber)
  )) ?? null;
}

function nullableMoney(value) {
  if (value === null || value === undefined || value === "") return "-";
  return Number.isFinite(Number(value)) ? `${fmt(value)}원` : "-";
}

function nullableNumber(value, suffix = "") {
  if (value === null || value === undefined || value === "") return "-";
  return Number.isFinite(Number(value)) ? `${fmt(value)}${suffix}` : "-";
}

function render() {
  if (!snapshot) return;
  if (lastSymbol !== snapshot.symbol) {
    lastSymbol = snapshot.symbol;
    limitPrice = snapshot.lastPrice;
  } else if (limitPrice === null) {
    limitPrice = snapshot.lastPrice;
  }

  const activeElement = document.activeElement;
  const activeId = activeElement?.id;
  const selectionStart = activeElement?.selectionStart;
  const selectionEnd = activeElement?.selectionEnd;
  const metrics = snapshot.metrics;
  const account = snapshot.account;
  const asks = snapshot.book.asks.slice(0, 7).reverse();
  const bids = snapshot.book.bids.slice(0, 7);
  const maxSize = Math.max(1, ...asks.map((level) => level.size), ...bids.map((level) => level.size));
  const signalLabel = metrics.signal === "BUY" ? "매수 후보" : metrics.signal === "SELL" ? "매도 후보" : "관망";
  const paperAvailable = Boolean(account.available);
  const disabled = busy || snapshot.system.killSwitch || !paperAvailable ? "disabled" : "";
  const limitDisabled = orderType === "MARKET" ? "disabled" : "";
  const feedConnected = Boolean(snapshot.system.feedConnected);
  const feedLabel = feedConnected
    ? "KIS 실시간 연결"
    : snapshot.system.marketDataSource === "KIS_REST"
      ? "KIS REST 시세"
      : "KIS 연결 대기";
  const dataAge = Number(snapshot.system.latencyMs) || 0;
  const accountNote = account.error?.message
    ? ` · ${escapeHtml(account.error.message)}`
    : "";

  app.className = "app-shell";
  app.innerHTML = `
    <header class="topbar"><div class="brand"><div class="pulse-logo">P</div><div><strong>PulseHFT</strong><span>Microstructure & KIS Paper Execution</span></div></div><div class="instrument"><div><span>${snapshot.symbol}</span><strong>${escapeHtml(snapshot.symbolName)}</strong></div><div class="headline-price"><strong>${fmt(snapshot.lastPrice)}</strong><span class="${snapshot.changePercent >= 0 ? "positive-text" : "negative-text"}">${signed(snapshot.changePercent, 2)}%</span></div></div><div class="top-status"><span class="simulation-badge">KIS PROD READ-ONLY</span><span class="connection ${feedConnected ? "connected" : connection}"><i></i>${feedLabel}</span><span class="latency">데이터 ${dataAge.toFixed(0)}ms</span></div></header>
    ${message ? `<div class="toast" data-action="dismiss">${escapeHtml(message)}</div>` : ""}
    ${snapshot.system.killSwitch ? '<div class="kill-banner">KIS 모의투자 킬 스위치가 활성화되어 신규·정정 주문이 차단되었습니다.</div>' : ""}
    <section class="metric-grid">${metric("가중 호가 불균형", `${signed(metrics.weightedImbalance * 100)}%`, "KIS 1~3호가 가중치 반영", tone(metrics.weightedImbalance))}${metric("체결 흐름", `${signed(metrics.tradeFlow * 100)}%`, "최근 5초 KIS 체결량", tone(metrics.tradeFlow))}${metric("거래 속도", `${metrics.tradesPerSecond.toFixed(1)}/초`, `${fmt(metrics.volumePerSecond)}주/초`)}${metric("모멘텀", `${signed(metrics.momentumBps, 2)}bp`, "최근 KIS 체결 가격 방향", tone(metrics.momentumBps))}${metric("스프레드", `${metrics.spreadTicks.toFixed(0)}틱`, `${fmt(metrics.spread)}원`, metrics.spreadTicks <= 1 ? "positive" : metrics.spreadTicks >= 3 ? "negative" : "neutral")}${metric("초단기 변동성", `${metrics.volatilityBps.toFixed(2)}bp`, "KIS 체결 수익률 표준편차")}</section>
    <section class="workspace-grid">
      <div class="chart-panel panel"><div class="panel-title-row"><div><span class="eyebrow">KIS INTRADAY MARKET VIEW</span><h3>실시간 가격·체결 구조</h3></div><div class="chart-legend"><span class="up">상승</span><span class="down">하락</span></div></div>${priceChart(snapshot.candles)}</div>
      <div class="book-panel panel"><div class="panel-title-row"><div><span class="eyebrow">KIS ORDER BOOK</span><h3>10단계 호가</h3></div></div><div class="book-head"><span>가격</span><span>잔량</span></div>${asks.map((level) => bookRow(level, "ask", maxSize)).join("")}<div class="last-price-row"><span>현재가</span><strong>${fmt(snapshot.lastPrice)}</strong></div>${bids.map((level) => bookRow(level, "bid", maxSize)).join("")}</div>
      <div class="signal-wrap"><div class="signal-panel signal-${metrics.signal.toLowerCase()}"><div class="signal-header"><div><span class="eyebrow">KIS MICROSTRUCTURE SIGNAL</span><h2>${signalLabel}</h2></div><div class="score-ring" style="--score:${metrics.confidence * 3.6}deg"><div><strong>${metrics.score}</strong><small>점수</small></div></div></div><div class="confidence-track"><span style="width:${metrics.confidence}%"></span></div><div class="signal-reasons">${metrics.reasons.slice(0, 4).map((reason) => `<div>• ${escapeHtml(reason)}</div>`).join("")}</div><p>KIS 실제 시세·호가·체결 기반 분석이며 투자 권유가 아닙니다.</p></div></div>
      <div class="tape-panel panel"><div class="panel-title-row"><div><span class="eyebrow">KIS TIME & SALES</span><h3>실시간 체결</h3></div></div><div class="trade-tape">${snapshot.trades.slice(0, 30).map((trade) => `<div class="trade-row ${String(trade.side).toLowerCase()}"><span>${new Date(trade.timestamp).toLocaleTimeString("ko-KR", { hour12: false, minute: "2-digit", second: "2-digit", fractionalSecondDigits: 1 })}</span><strong>${fmt(trade.price)}</strong><span>${fmt(trade.size)}</span></div>`).join("") || '<div class="empty-list">KIS 실시간 체결을 기다리는 중입니다.</div>'}</div></div>
    </section>
    <section class="execution-grid">
      <div class="paper-panel"><div class="panel-title-row"><div><span class="eyebrow">KIS PAPER ACCOUNT</span><h3>KIS 모의계좌 수동 주문</h3></div><button class="ghost-button" data-action="refresh" ${busy ? "disabled" : ""}>새로고침</button></div>
        <div class="account-grid">
          <div><span>총자산</span><strong>${nullableMoney(account.equity)}</strong></div>
          <div><span>가용현금</span><strong>${nullableMoney(account.availableCash)}</strong></div>
          <div><span>매수예약</span><strong>${nullableMoney(account.reservedCash)}</strong></div>
          <div><span>보유수량</span><strong>${nullableNumber(account.position.quantity, "주")}</strong></div>
          <div><span>매도가능</span><strong>${nullableNumber(account.sellableQuantity, "주")}</strong></div>
          <div><span>평균단가</span><strong>${nullableMoney(account.position.averagePrice)}</strong></div>
          <div><span>평가손익</span><strong class="${Number(account.unrealizedPnl) >= 0 ? "positive-text" : "negative-text"}">${nullableMoney(account.unrealizedPnl)}</strong></div>
          <div><span>실현손익</span><strong>-</strong></div>
        </div>
        <div class="order-entry">
          <label>주문 유형<select id="order-type"><option value="MARKET" ${orderType === "MARKET" ? "selected" : ""}>시장가</option><option value="LIMIT" ${orderType === "LIMIT" ? "selected" : ""}>지정가</option></select></label>
          <label>주문 수량<input id="quantity" type="number" min="1" max="${snapshot.riskLimits.maxOrderQuantity}" value="${quantity}"></label>
          <label>지정 가격<input id="limit-price" type="number" min="1" step="${snapshot.tickSize}" value="${limitPrice}" ${limitDisabled}></label>
          <div class="order-buttons"><button class="buy-button" data-action="buy" ${disabled}>KIS 모의 매수</button><button class="sell-button" data-action="sell" ${disabled}>KIS 모의 매도</button></div>
        </div>
        <div class="execution-note">주문 전 최종 확인을 거칩니다. ACCEPTED는 증권사 주문 접수이며 실제 체결 완료를 뜻하지 않습니다.${accountNote}</div>
        <div class="orders-list"><div class="table-head"><span>주문</span><span>유형·가격</span><span>주문번호·체결</span><span>상태</span><span>제어</span></div>${kisCommands.slice(0, 10).map(commandRow).join("") || '<div class="empty-list">이 브라우저에서 전송한 KIS 주문 명령이 없습니다.</div>'}</div>
      </div>
      <div class="system-panel"><div class="panel-title-row"><div><span class="eyebrow">KIS RISK & EXECUTION</span><h3>모의투자 주문 제어</h3></div></div><div class="execution-model"><span>주문 경계</span><strong>KIS PAPER · MANUAL ONLY</strong><small>실전주문 비활성 · 자동전략 미연결 · clientOrderId 멱등성</small></div><div class="control-row"><div><strong>자동주문</strong><span>내부 자동전략과 매수추천 자동주문은 연결되어 있지 않습니다.</span></div><button class="toggle" disabled><span></span></button></div><div class="control-row danger-row"><div><strong>킬 스위치</strong><span>KIS 모의계좌 신규·정정 주문 즉시 차단</span></div><button class="toggle danger ${snapshot.system.killSwitch ? "on" : ""}" data-action="kill" ${busy || !paperAvailable ? "disabled" : ""}><span></span></button></div><div class="risk-list"><div><span>1회 최대</span><strong>${fmt(snapshot.riskLimits.maxOrderQuantity)}주</strong></div><div><span>최대 주문금액</span><strong>${fmt(snapshot.riskLimits.maxOrderValue / 10000)}만원</strong></div><div><span>일일 주문</span><strong>${fmt(snapshot.riskLimits.maxDailyOrders)}건</strong></div><div><span>일일 손실 제한</span><strong>-${fmt(snapshot.riskLimits.maxDailyLoss / 10000)}만원</strong></div><div><span>취소 가능 주문</span><strong>${fmt(account.openOrderCount)}건</strong></div><div><span>매도 예약</span><strong>${fmt(account.reservedSellQuantity)}주</strong></div></div></div>
    </section><footer><span>시세·호가·체결은 KIS 실전계좌 읽기 전용 데이터입니다.</span><span>잔고와 주문은 KIS 모의투자이며 자동주문과 실전주문은 연결하지 않습니다.</span></footer>`;

  if (activeId) {
    const next = document.getElementById(activeId);
    if (next && !next.disabled) {
      next.focus({ preventScroll: true });
      if (typeof next.setSelectionRange === "function" && selectionStart !== null) {
        next.setSelectionRange(selectionStart, selectionEnd);
      }
    }
  }
}

async function run(action, { recordRequest = null } = {}) {
  try {
    busy = true;
    message = null;
    render();
    const result = await action();
    if (recordRequest) {
      kisCommands.unshift({
        id: recordRequest.clientOrderId,
        at: Date.now(),
        request: structuredClone(recordRequest),
        response: structuredClone(result),
      });
      kisCommands = kisCommands.slice(0, 30);
      writeStoredCommands();
    }
    if (result?.status === "REJECTED") message = `주문 거절: ${result.error?.message ?? "증권사 거절"}`;
    else if (result?.status === "UNKNOWN_RESULT") message = "주문 결과가 불명확합니다. 킬 스위치가 활성화됐는지 확인하세요.";
    else if (result?.status === "ACCEPTED") message = "KIS 모의주문이 접수됐습니다. 실제 체결 여부는 별도로 확인해야 합니다.";
    return result;
  } catch (error) {
    message = error instanceof Error ? error.message : "요청 처리 중 오류가 발생했습니다.";
    return null;
  } finally {
    busy = false;
    render();
  }
}

async function submit(side) {
  const requestBody = orderRequest(side);
  const priceText = requestBody.type === "MARKET"
    ? `시장가 · 기준가 ${fmt(requestBody.referencePrice)}원`
    : `지정가 ${fmt(requestBody.limitPrice)}원`;
  const confirmed = window.confirm(
    `KIS 모의계좌 ${side === "BUY" ? "매수" : "매도"} 주문을 전송할까요?\n${snapshot.symbol} ${snapshot.symbolName}\n${requestBody.quantity}주 · ${priceText}\n\nACCEPTED는 접수이며 체결 완료가 아닙니다.`,
  );
  if (!confirmed) return;
  await run(() => request("/api/kis/paper/orders", requestBody), { recordRequest: requestBody });
}

app.addEventListener("input", (event) => {
  if (event.target.id === "quantity") quantity = Math.max(1, Number(event.target.value) || 1);
  if (event.target.id === "limit-price") limitPrice = Math.max(1, Number(event.target.value) || 1);
});

app.addEventListener("change", (event) => {
  if (event.target.id === "order-type") {
    orderType = event.target.value;
    if (orderType === "LIMIT" && !limitPrice) limitPrice = snapshot.lastPrice;
    render();
  }
});

app.addEventListener("click", (event) => {
  const actionElement = event.target.closest("[data-action]");
  const action = actionElement?.dataset.action;
  if (!action) return;
  if (action === "dismiss") {
    message = null;
    render();
  }
  if (action === "buy") void submit("BUY");
  if (action === "sell") void submit("SELL");
  if (action === "refresh") void run(() => request("/api/kis/main/refresh", {}));
  if (action === "cancel-order") {
    const cancelBody = {
      clientOrderId: createClientOrderId("CANCEL"),
      originalOrderNumber: actionElement.dataset.orderNumber,
      orderOrganizationNumber: actionElement.dataset.orderOrganizationNumber,
      quantity: Number(actionElement.dataset.cancelQuantity),
      exchange: "KRX",
      allQuantity: true,
    };
    const confirmed = window.confirm(`KIS 모의주문 ${cancelBody.originalOrderNumber}의 취소 가능 수량 ${cancelBody.quantity}주를 전부 취소할까요?`);
    if (confirmed) void run(
      () => request("/api/kis/paper/orders/cancel", cancelBody),
      { recordRequest: { ...cancelBody, side: "CANCEL", type: "CANCEL" } },
    );
  }
  if (action === "kill") void run(() => request("/api/kis/paper/kill-switch", {
    enabled: !snapshot.system.killSwitch,
  }));
});

function connect() {
  connection = "connecting";
  render();
  const events = new EventSource("/api/events");
  events.addEventListener("snapshot", (event) => {
    connection = "connected";
    snapshot = JSON.parse(event.data);
    render();
  });
  events.onerror = () => {
    connection = "disconnected";
    render();
  };
}

function readStoredCommands() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KIS_COMMANDS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.slice(0, 30) : [];
  } catch {
    return [];
  }
}

function writeStoredCommands() {
  try { localStorage.setItem(KIS_COMMANDS_KEY, JSON.stringify(kisCommands.slice(0, 30))); } catch {
    // localStorage가 차단돼도 현재 세션 주문은 유지합니다.
  }
}

const staticMode = new URLSearchParams(window.location.search).has("static");
fetch("/api/snapshot", { headers: { Accept: "application/json" } })
  .then((response) => response.json())
  .then((data) => {
    snapshot = data;
    connection = staticMode ? "connected" : connection;
    render();
    if (!staticMode) connect();
  })
  .catch((error) => {
    message = error.message;
    render();
    if (!staticMode) setTimeout(connect, 1500);
  });
