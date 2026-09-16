// 모의계좌 자동매매 제어판 (docs/AUTO_TRADING_PAPER_DESIGN.md)
//
// 2026-09-11: 자동매매가 대사 불일치로 멈춘 채 3시간 동안 아무도 모르고 있었다.
// 상태와 멈춤 사유, 무엇을 들고 있는지, 무엇을 사고팔았는지를 한 화면에 드러낸다.

const app = document.querySelector("#app");

let status = null;
let balance = null;
let performance = null;
let busy = false;
let message = null;
let stopped = false;
let scheduled = false;
let showSettings = false;

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[char]);
const won = (value) => `${Math.round(Number(value) || 0).toLocaleString("ko-KR")}원`;
const signedWon = (value) => {
  const number = Math.round(Number(value) || 0);
  return `${number > 0 ? "+" : ""}${number.toLocaleString("ko-KR")}원`;
};
const pct = (value) => (Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(2)}%` : "-");
const bps = (value) => (Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)}bp` : "-");
const clock = (ms) => (ms ? new Date(ms).toLocaleTimeString("ko-KR", { hour12: false }) : "-");
const duration = (ms) => {
  if (!Number.isFinite(Number(ms))) return "-";
  const total = Math.floor(Number(ms) / 1_000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}분 ${seconds}초` : `${seconds}초`;
};

// 종목코드만 보이면 무엇을 거래했는지 알 수 없다. 이름을 아는 곳에서 끌어모은다.
function buildNameMap() {
  const map = new Map();
  for (const position of balance?.positions ?? []) {
    if (position?.symbol && position?.name) map.set(position.symbol, position.name);
  }
  for (const decision of status?.recentDecisions ?? []) {
    if (decision?.symbol && decision?.name) map.set(decision.symbol, decision.name);
    for (const item of decision?.evaluated ?? []) {
      if (item?.symbol && item?.name) map.set(item.symbol, item.name);
    }
  }
  if (status?.holding?.symbol && status?.holding?.name) {
    map.set(status.holding.symbol, status.holding.name);
  }
  return map;
}

const labelFor = (symbol, names) => {
  const name = names.get(symbol);
  return name ? `${escapeHtml(name)} <span class="at-code">${escapeHtml(symbol)}</span>`
    : escapeHtml(symbol ?? "-");
};

const REASON_TEXT = {
  ENTRY_SIGNAL: "진입 신호", STOP_LOSS: "손절", TAKE_PROFIT: "익절",
  TRAILING_STOP: "트레일링 스톱", MAX_HOLDING: "최대 보유시간", FORCED_EXIT: "장 종료 전 청산",
  COOLDOWN: "쿨다운 대기", NO_ELIGIBLE_CANDIDATE: "조건 맞는 종목 없음",
  NOT_ENTRY_READY: "실시간 확인 미통과", BELOW_NET_EDGE: "기대 순익이 문턱 미달",
  QUANTITY_TOO_SMALL: "자본 대비 1주 미만", STALE_QUOTE: "시세 지연",
  SPREAD_TOO_WIDE: "스프레드 과다", NO_EQUITY: "잔고 확인 불가",
  KILL_SWITCH: "주문 차단(킬 스위치)", UNKNOWN_RESULT: "주문 결과 불명",
  RECONCILIATION_MISMATCH: "계좌 대사 불일치", ORDER_FAILED: "주문 실패",
};
const reasonText = (code) => REASON_TEXT[code] ?? code ?? "-";

injectStyles();

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `요청이 실패했습니다 (${response.status})`);
  return body;
}

async function refresh() {
  if (stopped) return;
  try {
    const [next, paper] = await Promise.all([
      api("/api/kis/paper/auto-trading").catch(() => null),
      api("/api/kis/paper/status").catch(() => null),
    ]);
    status = next;
    if (status) {
      const [nextBalance, nextPerformance] = await Promise.all([
        api("/api/kis/paper/balance").catch(() => null),
        api("/api/kis/paper/performance").catch(() => null),
      ]);
      balance = nextBalance;
      performance = nextPerformance;
      status.paperService = paper?.service ?? null;
    }
  } catch {
    // 폴링 실패는 화면을 비우지 않는다. 직전 상태를 유지한다.
  }
  scheduleRender();
}

async function run(action) {
  busy = true; message = null; render();
  try {
    await action();
    await refresh();
  } catch (error) {
    message = { tone: "error", text: error instanceof Error ? error.message : String(error) };
  } finally {
    busy = false;
    render();
  }
}

const setEnabled = (enabled) => run(() => api("/api/kis/paper/auto-trading", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ enabled }),
}));

// 멈춤 해제는 두 단계다. 주문 서비스의 차단을 먼저 풀고(대사 확인 포함),
// 그 다음 자동매매의 멈춤을 푼다. 순서가 바뀌면 다음 주기에 다시 멈춘다.
const releaseHalt = () => run(async () => {
  if (status?.paperService?.killSwitch) {
    await api("/api/kis/paper/kill-switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
  }
  await api("/api/kis/paper/auto-trading/resume", { method: "POST" });
});

// 백그라운드 탭에서는 requestAnimationFrame이 아예 호출되지 않는다. 자동매매 모니터는
// 다른 탭에 띄워두는 것이 정상적인 사용 방식이므로, 숨겨진 탭에서는 타이머로 렌더한다.
function scheduleRender() {
  if (scheduled || stopped) return;
  scheduled = true;
  if (document.hidden) setTimeout(render, 0);
  else requestAnimationFrame(render);
}

function render() {
  scheduled = false;
  if (!app || stopped) return;
  const existing = app.querySelector(".auto-trading-panel");
  if (!status) { existing?.remove(); return; }
  const host = app.querySelector(".execution-grid") ?? app;

  const names = buildNameMap();
  const running = Boolean(status.enabled);
  const halted = Boolean(status.halted);
  const holding = status.holding;
  const trades = performance?.trades ?? null;

  const panel = existing ?? document.createElement("div");
  panel.className = "auto-trading-panel";
  panel.innerHTML = `
    <div class="at-head">
      <div>
        <div class="at-eyebrow">모의계좌 자동매매</div>
        <h3>${running ? "작동 중" : "정지"}</h3>
        <div class="at-sub">모의투자 계좌입니다. 실제 자금이 아닙니다.</div>
      </div>
      <div class="at-actions">
        <button type="button" class="at-btn ${running ? "at-btn-stop" : "at-btn-start"}"
          data-at-action="${running ? "stop" : "start"}" ${busy ? "disabled" : ""}>
          ${running ? "멈춤" : "시작"}
        </button>
        <button type="button" class="at-btn at-btn-ghost" data-at-action="settings">설정</button>
      </div>
    </div>

    ${halted ? `
      <div class="at-halt">
        <div>
          <strong>멈춤 — ${escapeHtml(reasonText(status.haltReason?.code))}</strong>
          <p>${escapeHtml(status.haltReason?.message ?? "")}</p>
          <small>${clock(status.haltReason?.at)}부터</small>
        </div>
        <button type="button" class="at-btn at-btn-release" data-at-action="release" ${busy ? "disabled" : ""}>
          멈춤 해제
        </button>
      </div>` : ""}

    ${message ? `<div class="at-message at-${escapeHtml(message.tone)}">${escapeHtml(message.text)}
      <button type="button" data-at-action="dismiss">닫기</button></div>` : ""}

    <div class="at-section">
      <div class="at-section-title">지금 보유 중인 종목</div>
      ${holding ? `
        <div class="at-holding">
          <div class="at-holding-name">${labelFor(holding.symbol, names)}</div>
          <div class="at-grid">
            <div><span>수량</span><strong>${holding.quantity}주</strong></div>
            <div><span>매입 단가</span><strong>${won(holding.averagePrice)}</strong></div>
            <div><span>현재가</span><strong>${won(holding.currentPrice)}</strong></div>
            <div><span>평가 손익</span><strong class="${Number(holding.evaluationProfitLoss) >= 0 ? "at-up" : "at-down"}">
              ${signedWon(holding.evaluationProfitLoss)}</strong></div>
            <div><span>수익률</span><strong class="${Number(holding.returnBps) >= 0 ? "at-up" : "at-down"}">
              ${bps(holding.returnBps)}</strong></div>
            <div><span>보유 시간</span><strong>${duration(holding.heldMs)}</strong></div>
          </div>
        </div>` : `<div class="at-empty">보유 중인 종목이 없습니다.</div>`}
    </div>

    <div class="at-section">
      <div class="at-section-title">사고판 내역
        ${trades ? `<span class="at-badge">${trades.realizedCount}건</span>` : ""}</div>
      ${trades && trades.recent?.length ? `
        <table class="at-table">
          <thead><tr><th>종목</th><th>수량</th><th>매수</th><th>매도</th>
            <th>총이익</th><th>비용</th><th>순익</th></tr></thead>
          <tbody>
            ${trades.recent.slice(-8).reverse().map((trade) => `
              <tr>
                <td>${labelFor(trade.symbol, names)}</td>
                <td>${trade.quantity}주</td>
                <td>${won(trade.buyAveragePrice)}</td>
                <td>${won(trade.sellPrice)}</td>
                <td class="${trade.grossPnl >= 0 ? "at-up" : "at-down"}">${signedWon(trade.grossPnl)}</td>
                <td class="at-cost">−${won(trade.totalCost)}</td>
                <td class="${trade.netPnl >= 0 ? "at-up" : "at-down"}"><strong>${signedWon(trade.netPnl)}</strong></td>
              </tr>`).join("")}
          </tbody>
        </table>
        <div class="at-totals">
          비용 차감 후 누적 <strong class="${trades.totalNetPnl >= 0 ? "at-up" : "at-down"}">
            ${signedWon(trades.totalNetPnl)}</strong>
          · 승률 ${trades.netWinRate === null ? "-" : pct(trades.netWinRate)}
          · 최대 낙폭 ${won(performance?.equity?.maxDrawdownAmount)}
          (${pct(performance?.equity?.maxDrawdownPct)})
        </div>` : `<div class="at-empty">아직 완료된 매매가 없습니다.</div>`}
    </div>

    <div class="at-section">
      <div class="at-section-title">최근 판단</div>
      ${status.recentDecisions?.length ? `
        <ul class="at-decisions">
          ${status.recentDecisions.slice(-6).reverse().map((decision) => `
            <li>
              <span class="at-time">${clock(decision.at)}</span>
              <span class="at-act at-act-${escapeHtml(String(decision.action).toLowerCase())}">
                ${escapeHtml(decisionLabel(decision))}</span>
              <span class="at-why">${escapeHtml(decisionDetail(decision, names))}</span>
            </li>`).join("")}
        </ul>` : `<div class="at-empty">아직 판단 기록이 없습니다.</div>`}
    </div>

    ${showSettings ? settingsHtml() : ""}
  `;
  if (!existing) host.append(panel);
  syncLegacyToggle(running, halted);
}

// app.js가 그리는 "모의투자 주문 제어"의 자동주문 줄은 원래 disabled 표시등이었다.
// 자동매매가 실제로 연결된 지금은 사실과 다르므로, 같은 자리에서 켜고 끌 수 있게 만든다.
// app.js는 스냅샷마다 전체를 다시 그리므로 MutationObserver가 이 함수를 다시 부른다.
function syncLegacyToggle(running, halted) {
  const rows = document.querySelectorAll(".system-panel .control-row");
  for (const row of rows) {
    if (row.querySelector("strong")?.textContent?.trim() !== "자동주문") continue;
    const description = row.querySelector("span");
    const toggle = row.querySelector("button.toggle");
    if (!toggle) continue;
    if (description) {
      description.textContent = running
        ? (halted ? "작동 중이나 멈춤 상태입니다. 아래 패널에서 사유를 확인하세요."
          : "매수추천 자동주문이 모의계좌에 연결되어 작동 중입니다.")
        : "모의계좌 자동주문이 정지 상태입니다.";
    }
    toggle.disabled = Boolean(busy);
    toggle.classList.toggle("on", running);
    toggle.dataset.atAction = running ? "stop" : "start";
    // app.js의 클릭 핸들러가 가로채지 않도록 자체 action은 비운다.
    delete toggle.dataset.action;
  }
}

function decisionLabel(decision) {
  if (decision.action === "ORDER") return decision.side === "BUY" ? "매수" : "매도";
  if (decision.action === "HOLD") return "보유";
  if (decision.action === "SKIP") return "대기";
  if (decision.action === "HALTED") return "멈춤";
  if (decision.action === "EXIT_BLOCKED") return "청산 차단";
  if (decision.action === "ORDER_ERROR") return "주문 실패";
  if (decision.action === "CYCLE_ERROR") return "조회 실패";
  if (decision.action === "DISABLED") return "정지";
  return decision.action;
}

function decisionDetail(decision, names) {
  const who = decision.symbol
    ? `${names.get(decision.symbol) ?? decision.symbol} `
    : "";
  if (decision.action === "ORDER") {
    return `${who}${decision.quantity}주 · ${reasonText(decision.reason)}`;
  }
  if (decision.action === "HOLD") return `${who}${decision.quantity}주 보유 중`;
  if (decision.action === "SKIP" && decision.reason === "NO_ELIGIBLE_CANDIDATE") {
    const top = (decision.evaluated ?? [])[0];
    return top ? `조건 미달 — ${top.name ?? top.symbol}: ${reasonText(top.reason)}` : "조건 맞는 종목 없음";
  }
  return decision.detail ?? reasonText(decision.reason);
}

function settingsHtml() {
  const s = status.settings ?? {};
  const rows = [
    ["최소 기대 순익", `${s.minimumNetEdgeBps}bp`],
    ["진입 비중", `자기자본 ${(s.positionSizeRatio * 100).toFixed(0)}%`],
    ["손절 / 익절", `${s.stopLossBps}bp / ${s.takeProfitBps}bp`],
    ["트레일링 스톱", `${s.trailingStopBps}bp`],
    ["최대 보유시간", `${Math.round(s.maxHoldingMs / 60_000)}분`],
    ["강제 청산", s.forcedExitTime ?? "없음"],
    ["평가 주기", `${Math.round(s.evaluationIntervalMs / 1_000)}초`],
  ];
  return `<div class="at-section at-settings">
    <div class="at-section-title">설정</div>
    <div class="at-grid">
      ${rows.map(([label, value]) => `<div><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}
    </div>
    <small>변경은 .env 또는 POST /api/kis/paper/auto-trading 으로 합니다.</small>
  </div>`;
}

app?.addEventListener("click", (event) => {
  const action = event.target.closest("[data-at-action]")?.dataset.atAction;
  if (!action) return;
  if (action === "start") void setEnabled(true);
  if (action === "stop") void setEnabled(false);
  if (action === "release") void releaseHalt();
  if (action === "settings") { showSettings = !showSettings; render(); }
  if (action === "dismiss") { message = null; render(); }
});

function injectStyles() {
  if (document.querySelector("#auto-trading-styles")) return;
  const style = document.createElement("style");
  style.id = "auto-trading-styles";
  style.textContent = `
    .auto-trading-panel{margin-top:12px;padding:16px 18px;border:1px solid #24506b;border-radius:12px;background:linear-gradient(180deg,#0c1722,#080f16)}
    .auto-trading-panel h3{margin:2px 0 0;color:#dbeeff;font-size:15px}
    .at-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px}
    .at-eyebrow{color:#6fb3e0;letter-spacing:.08em;font-size:10px;text-transform:uppercase}
    .at-sub{font-size:10px;color:#6f8ba0;margin-top:3px}
    .at-actions{display:flex;gap:8px}
    .at-btn{border-radius:7px;padding:7px 16px;font-size:12px;cursor:pointer;border:1px solid transparent}
    .at-btn[disabled]{opacity:.5;cursor:not-allowed}
    .at-btn-start{background:#1d7a4c;border-color:#2ea86a;color:#eafff3;font-weight:600}
    .at-btn-stop{background:#8a2f38;border-color:#b6444f;color:#ffeef0;font-weight:600}
    .at-btn-ghost{background:transparent;border-color:#2b4f68;color:#8fbcd8}
    .at-btn-release{background:#9a6516;border-color:#c98a23;color:#fff6e6;white-space:nowrap}
    .at-halt{display:flex;justify-content:space-between;align-items:center;gap:12px;background:#2a1a06;border:1px solid #7a5518;border-radius:9px;padding:10px 12px;margin-bottom:12px}
    .at-halt strong{color:#ffd89a;font-size:12px}
    .at-halt p{margin:3px 0 0;font-size:11px;color:#d8b98a}
    .at-halt small{font-size:10px;color:#9a8055}
    .at-message{margin-bottom:10px;padding:8px 10px;border-radius:7px;font-size:11px;display:flex;justify-content:space-between;gap:8px}
    .at-error{background:#2b1114;border:1px solid #7d3038;color:#ffc9cf}
    .at-message button{background:none;border:none;color:inherit;cursor:pointer;font-size:10px}
    .at-section{margin-top:12px}
    .at-section-title{font-size:10px;color:#6f8ba0;letter-spacing:.06em;margin-bottom:6px;display:flex;align-items:center;gap:6px}
    .at-badge{background:#16304a;color:#8fc4e8;border-radius:9px;padding:1px 7px;font-size:9px}
    .at-empty{font-size:11px;color:#5d7385;padding:8px 0}
    .at-holding-name{font-size:13px;color:#dbeeff;margin-bottom:7px}
    .at-code{font-size:10px;color:#6f8ba0}
    .at-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(92px,1fr));gap:7px}
    .at-grid div{background:#0a141d;border:1px solid #1c344a;border-radius:7px;padding:7px 9px;display:flex;flex-direction:column;gap:2px}
    .at-grid span{font-size:9px;color:#6f8ba0}
    .at-grid strong{font-size:12px;color:#dbeeff}
    .at-up{color:#5fd39b}
    .at-down{color:#ff8f9e}
    .at-cost{color:#c9a36a}
    .at-table{width:100%;border-collapse:collapse;font-size:11px}
    .at-table th{text-align:left;font-weight:500;color:#6f8ba0;font-size:9px;padding:4px 6px;border-bottom:1px solid #1c344a}
    .at-table td{padding:5px 6px;border-bottom:1px solid #12242f;color:#c3d8e8}
    .at-totals{margin-top:7px;font-size:11px;color:#8fa9bd}
    .at-decisions{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
    .at-decisions li{display:grid;grid-template-columns:58px 76px 1fr;gap:8px;font-size:11px;align-items:baseline}
    .at-time{color:#5d7385;font-size:10px}
    .at-act{font-size:10px;border-radius:5px;padding:1px 6px;text-align:center;background:#16304a;color:#8fc4e8}
    .at-act-order{background:#123a2a;color:#6fd6a2}
    .at-act-halted,.at-act-exit_blocked,.at-act-order_error{background:#3a1418;color:#ff9aa6}
    .at-why{color:#8fa9bd}
    .at-settings small{display:block;margin-top:7px;font-size:10px;color:#5d7385}
  `;
  document.head.append(style);
}

const observer = new MutationObserver(scheduleRender);
if (app) observer.observe(app, { childList: true });
const interval = setInterval(refresh, 3_000);
window.addEventListener("focus", refresh);
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
window.addEventListener("pagehide", () => {
  stopped = true;
  clearInterval(interval);
  observer.disconnect();
}, { once: true });

void refresh();
