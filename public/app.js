const app = document.querySelector("#app");
let snapshot = null;
let connection = "connecting";
let busy = false;
let quantity = 10;
let message = null;

const fmt = (value) => Math.round(value).toLocaleString("ko-KR");
const signed = (value, digits = 1) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
const tone = (value) => value > 0.03 ? "positive" : value < -0.03 ? "negative" : "neutral";
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

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
  const width = 1000, height = 360;
  const padding = { top: 24, right: 72, bottom: 30, left: 14 };
  const values = data.flatMap((item) => [item.high, item.low]);
  const min = Math.min(...values), max = Math.max(...values), range = Math.max(100, max - min);
  const y = (price) => padding.top + ((max - price) / range) * (height - padding.top - padding.bottom);
  const step = (width - padding.left - padding.right) / data.length;
  const candleWidth = Math.max(2, Math.min(8, step * .55));
  const grids = Array.from({ length: 5 }, (_, i) => max - range * i / 4).map((price) => `<g><line x1="${padding.left}" x2="${width-padding.right}" y1="${y(price)}" y2="${y(price)}" class="chart-grid"/><text x="${width-padding.right+8}" y="${y(price)+4}" class="chart-label">${fmt(price)}</text></g>`).join("");
  const path = data.map((item, index) => `${index ? "L" : "M"}${(padding.left+step*index+step/2).toFixed(1)},${y(item.close).toFixed(1)}`).join(" ");
  const bars = data.map((item, index) => {
    const x = padding.left + step * index + step / 2;
    const cls = item.close >= item.open ? "candle-up" : "candle-down";
    const top = y(Math.max(item.open, item.close)), bottom = y(Math.min(item.open, item.close));
    return `<g class="${cls}"><line x1="${x}" x2="${x}" y1="${y(item.high)}" y2="${y(item.low)}"/><rect x="${x-candleWidth/2}" y="${top}" width="${candleWidth}" height="${Math.max(1.5,bottom-top)}" rx="1"/></g>`;
  }).join("");
  return `<svg class="price-chart" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="priceArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="rgba(99,216,255,.24)"/><stop offset="100%" stop-color="rgba(99,216,255,0)"/></linearGradient></defs>${grids}<path d="${path} L${width-padding.right},${height-padding.bottom} L${padding.left},${height-padding.bottom} Z" fill="url(#priceArea)"/><path d="${path}" class="chart-line"/>${bars}</svg>`;
}

function metric(label, value, detail, className="neutral") { return `<div class="metric-card ${className}"><span>${label}</span><strong>${value}</strong><small>${detail}</small></div>`; }
function bookRow(level, type, maxSize) { return `<div class="book-row ${type}"><div class="book-depth" style="width:${Math.max(4,level.size/maxSize*100)}%"></div><span class="book-price">${fmt(level.price)}</span><span class="book-size">${fmt(level.size)}</span></div>`; }

function render() {
  if (!snapshot) return;
  const m = snapshot.metrics, a = snapshot.account;
  const asks = snapshot.book.asks.slice(0,7).reverse(), bids = snapshot.book.bids.slice(0,7);
  const maxSize = Math.max(1, ...asks.map(x=>x.size), ...bids.map(x=>x.size));
  const signalLabel = m.signal === "BUY" ? "매수 후보" : m.signal === "SELL" ? "매도 후보" : "관망";
  const feedConnected = Boolean(snapshot.system.feedConnected);
  const feedLabel = feedConnected ? "시세 연결" : snapshot.system.connectionState === "error" ? "시세 오류" : "시세 연결 중";
  const disabled = busy || snapshot.system.killSwitch || !feedConnected ? "disabled" : "";
  app.className = "app-shell";
  app.innerHTML = `
    <header class="topbar"><div class="brand"><div class="pulse-logo">P</div><div><strong>PulseHFT</strong><span>Microstructure & Paper Execution</span></div></div><div class="instrument"><div><span>${snapshot.symbol}</span><strong>${snapshot.symbolName}</strong></div><div class="headline-price"><strong>${fmt(snapshot.lastPrice)}</strong><span class="${snapshot.changePercent>=0?'positive-text':'negative-text'}">${signed(snapshot.changePercent,2)}%</span></div></div><div class="top-status"><span class="simulation-badge">${escapeHtml(snapshot.system.mode)}</span><span class="connection ${feedConnected?'connected':'disconnected'}"><i></i>${feedLabel}</span><span class="latency">${escapeHtml(snapshot.system.provider)} · 분석 ${snapshot.system.latencyMs.toFixed(1)}ms</span></div></header>
    ${message?`<div class="toast" data-action="dismiss">${escapeHtml(message)}</div>`:""}
    ${snapshot.system.lastError?`<div class="feed-error-banner">LS 시세 연결 오류: ${escapeHtml(snapshot.system.lastError)}</div>`:""}
    ${snapshot.system.killSwitch?'<div class="kill-banner">킬 스위치가 활성화되어 모든 신규 주문이 차단되었습니다.</div>':""}
    <section class="metric-grid">${metric("가중 호가 불균형",`${signed(m.weightedImbalance*100)}%`,"1~3호가 가중치 반영",tone(m.weightedImbalance))}${metric("체결 흐름",`${signed(m.tradeFlow*100)}%`,"최근 5초 매수·매도 체결량",tone(m.tradeFlow))}${metric("거래 속도",`${m.tradesPerSecond.toFixed(1)}/초`,`${fmt(m.volumePerSecond)}주/초`)}${metric("모멘텀",`${signed(m.momentumBps,2)}bp`,"최근 5초 가격 방향",tone(m.momentumBps))}${metric("스프레드",`${m.spreadTicks.toFixed(0)}틱`,`${fmt(m.spread)}원`,m.spreadTicks<=1?'positive':m.spreadTicks>=3?'negative':'neutral')}${metric("초단기 변동성",`${m.volatilityBps.toFixed(2)}bp`,"틱 수익률 표준편차")}</section>
    <section class="workspace-grid">
      <div class="chart-panel panel"><div class="panel-title-row"><div><span class="eyebrow">1-SECOND MARKET VIEW</span><h3>실시간 가격·체결 구조</h3></div><div class="chart-legend"><span class="up">상승</span><span class="down">하락</span></div></div>${priceChart(snapshot.candles)}</div>
      <div class="book-panel panel"><div class="panel-title-row"><div><span class="eyebrow">ORDER BOOK</span><h3>10단계 호가</h3></div></div><div class="book-head"><span>가격</span><span>잔량</span></div>${asks.map(x=>bookRow(x,'ask',maxSize)).join('')}<div class="last-price-row"><span>현재가</span><strong>${fmt(snapshot.lastPrice)}</strong></div>${bids.map(x=>bookRow(x,'bid',maxSize)).join('')}</div>
      <div class="signal-wrap"><div class="signal-panel signal-${m.signal.toLowerCase()}"><div class="signal-header"><div><span class="eyebrow">MICROSTRUCTURE SIGNAL</span><h2>${signalLabel}</h2></div><div class="score-ring" style="--score:${m.confidence*3.6}deg"><div><strong>${m.score}</strong><small>점수</small></div></div></div><div class="confidence-track"><span style="width:${m.confidence}%"></span></div><div class="signal-reasons">${m.reasons.slice(0,4).map(x=>`<div>• ${escapeHtml(x)}</div>`).join('')}</div><p>${snapshot.system.mode === 'SIMULATION' ? '내부 모의 시세' : 'LS증권 실시간 시세'} 기반 분석 결과이며 투자 권유가 아닙니다.</p></div></div>
      <div class="tape-panel panel"><div class="panel-title-row"><div><span class="eyebrow">TIME & SALES</span><h3>실시간 체결</h3></div></div><div class="trade-tape">${snapshot.trades.slice(0,30).map(t=>`<div class="trade-row ${t.side.toLowerCase()}"><span>${new Date(t.timestamp).toLocaleTimeString('ko-KR',{hour12:false,minute:'2-digit',second:'2-digit',fractionalSecondDigits:1})}</span><strong>${fmt(t.price)}</strong><span>${t.size}</span></div>`).join('')}</div></div>
    </section>
    <section class="execution-grid">
      <div class="paper-panel"><div class="panel-title-row"><div><span class="eyebrow">PAPER ACCOUNT</span><h3>모의매매</h3></div><button class="ghost-button" data-action="reset" ${busy?'disabled':''}>초기화</button></div><div class="account-grid"><div><span>총자산</span><strong>${fmt(a.equity)}원</strong></div><div><span>가용현금</span><strong>${fmt(a.cash)}원</strong></div><div><span>보유수량</span><strong>${a.position.quantity}주</strong></div><div><span>평균단가</span><strong>${fmt(a.position.averagePrice)}원</strong></div><div><span>평가손익</span><strong class="${a.unrealizedPnl>=0?'positive-text':'negative-text'}">${fmt(a.unrealizedPnl)}원</strong></div><div><span>실현손익</span><strong class="${a.realizedPnl>=0?'positive-text':'negative-text'}">${fmt(a.realizedPnl)}원</strong></div></div><div class="order-entry"><label>주문 수량<input id="quantity" type="number" min="1" max="${snapshot.riskLimits.maxOrderQuantity}" value="${quantity}"></label><div class="order-buttons"><button class="buy-button" data-action="buy" ${disabled}>모의 매수</button><button class="sell-button" data-action="sell" ${disabled}>모의 매도</button></div></div><div class="orders-list"><div class="table-head"><span>주문</span><span>체결가</span><span>결과</span></div>${a.orders.slice(0,7).map(o=>`<div class="order-row"><span class="${o.side==='BUY'?'positive-text':'negative-text'}">${o.side==='BUY'?'매수':'매도'} ${o.requestedQuantity}주</span><span>${o.filledPrice?fmt(o.filledPrice):'-'}</span><span class="${o.status==='FILLED'?'status-ok':'status-error'}">${escapeHtml(o.status==='FILLED'?o.source:o.reason)}</span></div>`).join('')||'<div class="empty-list">아직 주문 내역이 없습니다.</div>'}</div></div>
      <div class="system-panel"><div class="panel-title-row"><div><span class="eyebrow">RISK & EXECUTION</span><h3>자동매매 제어</h3></div></div><div class="feed-source-row"><span>시세 공급자</span><strong>${escapeHtml(snapshot.system.provider)}</strong><small>${escapeHtml(snapshot.system.mode)} · ${feedLabel}</small></div><div class="control-row"><div><strong>모의 자동전략</strong><span>신호 50점 이상·5초 쿨다운</span></div><button class="toggle ${snapshot.system.autoPaperTrading?'on':''}" data-action="auto" ${busy||snapshot.system.killSwitch||!feedConnected?'disabled':''}><span></span></button></div><div class="control-row danger-row"><div><strong>킬 스위치</strong><span>모든 신규 주문과 자동전략 즉시 차단</span></div><button class="toggle danger ${snapshot.system.killSwitch?'on':''}" data-action="kill" ${busy?'disabled':''}><span></span></button></div><div class="risk-list"><div><span>1회 최대</span><strong>${snapshot.riskLimits.maxOrderQuantity}주</strong></div><div><span>최대 보유</span><strong>${snapshot.riskLimits.maxPositionQuantity}주</strong></div><div><span>최대 포지션</span><strong>${fmt(snapshot.riskLimits.maxPositionNotional/10000)}만원</strong></div><div><span>일일 손실 제한</span><strong>-${fmt(snapshot.riskLimits.dailyLossLimit/10000)}만원</strong></div></div></div>
    </section><footer><span>시세: ${escapeHtml(snapshot.system.mode)} · 주문: 내부 모의체결 전용</span><span>실계좌 주문은 아직 비활성화되어 있습니다.</span></footer>`;
}

async function run(action) {
  try { busy=true; message=null; render(); await action(); }
  catch(error){ message=error instanceof Error?error.message:"요청 처리 중 오류가 발생했습니다."; }
  finally { busy=false; render(); }
}

app.addEventListener("input", (event) => { if (event.target.id === "quantity") quantity = Math.max(1, Number(event.target.value)||1); });
app.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) return;
  if (action === "dismiss") { message=null; render(); }
  if (action === "buy") void run(()=>request("/api/paper/orders",{side:"BUY",quantity}));
  if (action === "sell") void run(()=>request("/api/paper/orders",{side:"SELL",quantity}));
  if (action === "reset") void run(()=>request("/api/paper/reset"));
  if (action === "auto") void run(()=>request("/api/strategy/auto",{enabled:!snapshot.system.autoPaperTrading}));
  if (action === "kill") void run(()=>request("/api/system/kill-switch",{enabled:!snapshot.system.killSwitch}));
});

function connect() {
  connection="connecting"; render();
  const events = new EventSource("/api/events");
  events.addEventListener("snapshot", (event) => { connection="connected"; snapshot=JSON.parse(event.data); render(); });
  events.onerror = () => { connection="disconnected"; render(); };
}

const staticMode = new URLSearchParams(window.location.search).has("static");
fetch("/api/snapshot").then(r=>r.json()).then(data=>{snapshot=data;connection=staticMode?"connected":connection;render();if(!staticMode)connect();}).catch(error=>{message=error.message;render();if(!staticMode)setTimeout(connect,1500)});
