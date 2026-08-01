const app = document.querySelector("#app");
let snapshot = null;
let connection = "connecting";
let busy = false;
let quantity = 10;
let orderType = "MARKET";
let limitPrice = null;
let message = null;

const fmt = (value) => Math.round(Number(value) || 0).toLocaleString("ko-KR");
const signed = (value, digits = 1) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
const tone = (value) => value > 0.03 ? "positive" : value < -0.03 ? "negative" : "neutral";
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&quot;",
})[char]);

async function request(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `요청 실패 (${response.status})`);
  return result;
}

function priceChart(candles) {
  const data = candles.slice(-90);
  if (data.length < 2) return '<div class="chart-empty">차트 데이터를 수집하는 중입니다.</div>';
  const width = 1000;
  const height = 360;
  const padding = { top: 24, right: 72, bottom: 30, left: 14 };
  const values = data.flatMap((item) => [item.high, item.low]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(100, max - min);
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

function statusLabel(order) {
  if (order.status === "ACCEPTED") return "접수·대기";
  if (order.status === "PARTIALLY_FILLED") return order.isOpen ? "부분체결·대기" : "부분체결·IOC 종료";
  if (order.status === "FILLED") return "체결완료";
  if (order.status === "CANCELLED") return "취소";
  if (order.status === "REJECTED") return "거절";
  return order.status;
}

function orderTypeLabel(order) {
  if (order.type === "MARKET") return "시장가 IOC";
  return `지정가 ${fmt(order.limitPrice)}`;
}

function orderRow(order) {
  const sideClass = order.side === "BUY" ? "positive-text" : "negative-text";
  const statusClass = ["FILLED", "ACCEPTED", "PARTIALLY_FILLED"].includes(order.status)
    ? "status-ok"
    : "status-error";
  const fillText = order.filledQuantity > 0
    ? `${order.filledQuantity}/${order.requestedQuantity}주 · ${fmt(order.averageFilledPrice)}`
    : `0/${order.requestedQuantity}주`;
  return `<div class="order-row" title="${escapeHtml(order.reason)}">
    <span class="${sideClass}">${order.side === "BUY" ? "매수" : "매도"} ${order.requestedQuantity}주</span>
    <span>${orderTypeLabel(order)}</span>
    <span>${fillText}</span>
    <span class="${statusClass}">${statusLabel(order)}</span>
    <span>${order.isOpen ? `<button class="cancel-order-button" data-action="cancel-order" data-order-id="${escapeHtml(order.id)}">취소</button>` : "-"}</span>
  </div>`;
}

function createClientOrderId(side) {
  if (globalThis.crypto?.randomUUID) return `ui-${side.toLowerCase()}-${crypto.randomUUID()}`;
  return `ui-${side.toLowerCase()}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function orderRequest(side) {
  const body = {
    side,
    type: orderType,
    quantity,
    clientOrderId: createClientOrderId(side),
  };
  if (orderType === "LIMIT") body.limitPrice = limitPrice;
  return body;
}

function render() {
  if (!snapshot) return;
  if (limitPrice === null) limitPrice = snapshot.lastPrice;

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
  const disabled = busy || snapshot.system.killSwitch ? "disabled" : "";
  const limitDisabled = orderType === "MARKET" ? "disabled" : "";

  app.className = "app-shell";
  app.innerHTML = `
    <header class="topbar"><div class="brand"><div class="pulse-logo">P</div><div><strong>PulseHFT</strong><span>Microstructure & Paper Execution</span></div></div><div class="instrument"><div><span>${snapshot.symbol}</span><strong>${snapshot.symbolName}</strong></div><div class="headline-price"><strong>${fmt(snapshot.lastPrice)}</strong><span class="${snapshot.changePercent >= 0 ? "positive-text" : "negative-text"}">${signed(snapshot.changePercent, 2)}%</span></div></div><div class="top-status"><span class="simulation-badge">SIMULATION</span><span class="connection ${connection}"><i></i>${connection === "connected" ? "실시간 연결" : connection === "connecting" ? "연결 중" : "재연결 중"}</span><span class="latency">분석 ${snapshot.system.latencyMs.toFixed(1)}ms</span></div></header>
    ${message ? `<div class="toast" data-action="dismiss">${escapeHtml(message)}</div>` : ""}
    ${snapshot.system.killSwitch ? '<div class="kill-banner">킬 스위치가 활성화되어 모든 신규 주문이 차단되었습니다.</div>' : ""}
    <section class="metric-grid">${metric("가중 호가 불균형", `${signed(metrics.weightedImbalance * 100)}%`, "1~3호가 가중치 반영", tone(metrics.weightedImbalance))}${metric("체결 흐름", `${signed(metrics.tradeFlow * 100)}%`, "최근 5초 매수·매도 체결량", tone(metrics.tradeFlow))}${metric("거래 속도", `${metrics.tradesPerSecond.toFixed(1)}/초`, `${fmt(metrics.volumePerSecond)}주/초`)}${metric("모멘텀", `${signed(metrics.momentumBps, 2)}bp`, "최근 5초 가격 방향", tone(metrics.momentumBps))}${metric("스프레드", `${metrics.spreadTicks.toFixed(0)}틱`, `${fmt(metrics.spread)}원`, metrics.spreadTicks <= 1 ? "positive" : metrics.spreadTicks >= 3 ? "negative" : "neutral")}${metric("초단기 변동성", `${metrics.volatilityBps.toFixed(2)}bp`, "틱 수익률 표준편차")}</section>
    <section class="workspace-grid">
      <div class="chart-panel panel"><div class="panel-title-row"><div><span class="eyebrow">1-SECOND MARKET VIEW</span><h3>실시간 가격·체결 구조</h3></div><div class="chart-legend"><span class="up">상승</span><span class="down">하락</span></div></div>${priceChart(snapshot.candles)}</div>
      <div class="book-panel panel"><div class="panel-title-row"><div><span class="eyebrow">ORDER BOOK</span><h3>10단계 호가</h3></div></div><div class="book-head"><span>가격</span><span>잔량</span></div>${asks.map((level) => bookRow(level, "ask", maxSize)).join("")}<div class="last-price-row"><span>현재가</span><strong>${fmt(snapshot.lastPrice)}</strong></div>${bids.map((level) => bookRow(level, "bid", maxSize)).join("")}</div>
      <div class="signal-wrap"><div class="signal-panel signal-${metrics.signal.toLowerCase()}"><div class="signal-header"><div><span class="eyebrow">MICROSTRUCTURE SIGNAL</span><h2>${signalLabel}</h2></div><div class="score-ring" style="--score:${metrics.confidence * 3.6}deg"><div><strong>${metrics.score}</strong><small>점수</small></div></div></div><div class="confidence-track"><span style="width:${metrics.confidence}%"></span></div><div class="signal-reasons">${metrics.reasons.slice(0, 4).map((reason) => `<div>• ${escapeHtml(reason)}</div>`).join("")}</div><p>이 신호는 모의 데이터 기반 분석 결과이며 투자 권유가 아닙니다.</p></div></div>
      <div class="tape-panel panel"><div class="panel-title-row"><div><span class="eyebrow">TIME & SALES</span><h3>실시간 체결</h3></div></div><div class="trade-tape">${snapshot.trades.slice(0, 30).map((trade) => `<div class="trade-row ${trade.side.toLowerCase()}"><span>${new Date(trade.timestamp).toLocaleTimeString("ko-KR", { hour12: false, minute: "2-digit", second: "2-digit", fractionalSecondDigits: 1 })}</span><strong>${fmt(trade.price)}</strong><span>${trade.size}</span></div>`).join("")}</div></div>
    </section>
    <section class="execution-grid">
      <div class="paper-panel"><div class="panel-title-row"><div><span class="eyebrow">PAPER ACCOUNT</span><h3>호가 기반 모의주문</h3></div><button class="ghost-button" data-action="reset" ${busy ? "disabled" : ""}>초기화</button></div>
        <div class="account-grid">
          <div><span>총자산</span><strong>${fmt(account.equity)}원</strong></div>
          <div><span>가용현금</span><strong>${fmt(account.availableCash)}원</strong></div>
          <div><span>매수예약</span><strong>${fmt(account.reservedCash)}원</strong></div>
          <div><span>보유수량</span><strong>${account.position.quantity}주</strong></div>
          <div><span>매도가능</span><strong>${account.sellableQuantity}주</strong></div>
          <div><span>평균단가</span><strong>${fmt(account.position.averagePrice)}원</strong></div>
          <div><span>평가손익</span><strong class="${account.unrealizedPnl >= 0 ? "positive-text" : "negative-text"}">${fmt(account.unrealizedPnl)}원</strong></div>
          <div><span>실현손익</span><strong class="${account.realizedPnl >= 0 ? "positive-text" : "negative-text"}">${fmt(account.realizedPnl)}원</strong></div>
        </div>
        <div class="order-entry">
          <label>주문 유형<select id="order-type"><option value="MARKET" ${orderType === "MARKET" ? "selected" : ""}>시장가 IOC</option><option value="LIMIT" ${orderType === "LIMIT" ? "selected" : ""}>지정가 GTC</option></select></label>
          <label>주문 수량<input id="quantity" type="number" min="1" max="${snapshot.riskLimits.maxOrderQuantity}" value="${quantity}"></label>
          <label>지정 가격<input id="limit-price" type="number" min="1" step="${snapshot.tickSize}" value="${limitPrice}" ${limitDisabled}></label>
          <div class="order-buttons"><button class="buy-button" data-action="buy" ${disabled}>모의 매수</button><button class="sell-button" data-action="sell" ${disabled}>모의 매도</button></div>
        </div>
        <div class="execution-note">시장가는 화면의 반대편 호가 잔량을 순서대로 소비하며, 보이는 잔량이 부족하면 IOC 잔량을 취소합니다. 지정가는 가격이 교차할 때만 체결되고 미체결 잔량은 대기합니다.</div>
        <div class="orders-list"><div class="table-head"><span>주문</span><span>유형·가격</span><span>체결수량·평균가</span><span>상태</span><span>제어</span></div>${account.orders.slice(0, 10).map(orderRow).join("") || '<div class="empty-list">아직 주문 내역이 없습니다.</div>'}</div>
      </div>
      <div class="system-panel"><div class="panel-title-row"><div><span class="eyebrow">RISK & EXECUTION</span><h3>자동매매 제어</h3></div></div><div class="execution-model"><span>모의체결 모델</span><strong>Visible Depth</strong><small>시장가 IOC · 지정가 GTC · 중복주문 방지</small></div><div class="control-row"><div><strong>모의 자동전략</strong><span>신호 50점 이상·시장가 IOC·5초 쿨다운</span></div><button class="toggle ${snapshot.system.autoPaperTrading ? "on" : ""}" data-action="auto" ${busy || snapshot.system.killSwitch ? "disabled" : ""}><span></span></button></div><div class="control-row danger-row"><div><strong>킬 스위치</strong><span>모든 신규 주문과 자동전략 즉시 차단</span></div><button class="toggle danger ${snapshot.system.killSwitch ? "on" : ""}" data-action="kill" ${busy ? "disabled" : ""}><span></span></button></div><div class="risk-list"><div><span>1회 최대</span><strong>${snapshot.riskLimits.maxOrderQuantity}주</strong></div><div><span>최대 보유</span><strong>${snapshot.riskLimits.maxPositionQuantity}주</strong></div><div><span>최대 포지션</span><strong>${fmt(snapshot.riskLimits.maxPositionNotional / 10000)}만원</strong></div><div><span>일일 손실 제한</span><strong>-${fmt(snapshot.riskLimits.dailyLossLimit / 10000)}만원</strong></div><div><span>대기 주문</span><strong>${account.openOrderCount}건</strong></div><div><span>매도 예약</span><strong>${account.reservedSellQuantity}주</strong></div></div></div>
    </section><footer><span>현재 버전은 모의 시세·호가 기반 모의체결 전용입니다.</span><span>수수료·세금·실제 큐 순서는 아직 반영하지 않습니다.</span></footer>`;

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

async function run(action) {
  try {
    busy = true;
    message = null;
    render();
    const result = await action();
    if (result?.status === "REJECTED") message = `주문 거절: ${result.reason}`;
  } catch (error) {
    message = error instanceof Error ? error.message : "요청 처리 중 오류가 발생했습니다.";
  } finally {
    busy = false;
    render();
  }
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
  if (action === "buy") void run(() => request("/api/paper/orders", orderRequest("BUY")));
  if (action === "sell") void run(() => request("/api/paper/orders", orderRequest("SELL")));
  if (action === "cancel-order") {
    const orderId = actionElement.dataset.orderId;
    void run(() => request(`/api/paper/orders/${encodeURIComponent(orderId)}/cancel`));
  }
  if (action === "reset") void run(() => request("/api/paper/reset"));
  if (action === "auto") void run(() => request("/api/strategy/auto", { enabled: !snapshot.system.autoPaperTrading }));
  if (action === "kill") void run(() => request("/api/system/kill-switch", { enabled: !snapshot.system.killSwitch }));
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

const staticMode = new URLSearchParams(window.location.search).has("static");
fetch("/api/snapshot")
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
