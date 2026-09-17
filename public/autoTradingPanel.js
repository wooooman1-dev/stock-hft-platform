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
let limits = null;
let limitBounds = null;
let allTrades = null;
let loadingAllTrades = false;
// app.js가 #app.innerHTML을 통째로 다시 그리므로(app.js:190) 이 패널도 그때마다
// 파괴되고 재생성된다. 입력 중이던 값과 커서를 DOM에 의존해 지킬 수 없으므로
// 모듈 상태로 들고 있다가 렌더 후 복원한다.
const draft = { strategy: {}, limits: {} };
let focusState = null;

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
  for (const trade of performance?.trades?.recent ?? []) {
    if (trade?.symbol && trade?.name) map.set(trade.symbol, trade.name);
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
      const [nextBalance, nextPerformance, nextLimits] = await Promise.all([
        api("/api/kis/paper/balance").catch(() => null),
        api("/api/kis/paper/performance").catch(() => null),
        api("/api/kis/paper/limits").catch(() => null),
      ]);
      balance = nextBalance;
      performance = nextPerformance;
      if (nextLimits) { limits = nextLimits.limits; limitBounds = nextLimits.bounds; }
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
// 다만 호출 시점엔 탭이 보이고 있어도(그래서 requestAnimationFrame을 선택해도) 그
// 프레임이 그려지기 전에 탭이 백그라운드로 전환되면 콜백이 무기한 미뤄질 수 있다
// (2026-09-16 — "자동주문" 토글이 app.js가 다시 그릴 때마다 원래 상태로 초기화됐다가,
// 이 프레임이 지연되는 동안 수십 초씩 "불러오는 중" 상태로 보이던 문제의 원인이었다).
// requestAnimationFrame과 짧은 타이머를 동시에 걸어 두고 먼저 실행되는 쪽으로
// 렌더해서, 탭이 언제 백그라운드로 전환되든 빠르게 복구되게 한다.
function scheduleRender() {
  if (scheduled || stopped) return;
  scheduled = true;
  if (document.hidden) {
    setTimeout(render, 0);
    return;
  }
  let done = false;
  const runOnce = () => {
    if (done) return;
    done = true;
    render();
  };
  requestAnimationFrame(runOnce);
  setTimeout(runOnce, 200);
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
  const trades = allTrades ?? performance?.trades ?? null;

  const panel = existing ?? document.createElement("div");
  panel.className = "auto-trading-panel";

  // 3초마다 폴링하면서 innerHTML을 통째로 갈아엎으면 사용자가 타이핑 중인 입력이
  // 매번 지워진다. 실시간 영역만 다시 그리고, 설정 폼은 열고 닫을 때만 만든다.
  let live = panel.querySelector(":scope > .at-live");
  if (!live) {
    panel.textContent = "";
    live = document.createElement("div");
    live.className = "at-live";
    panel.append(live);
  }
  live.innerHTML = `
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
        ${trades ? `<span class="at-badge">${trades.realizedCount}건</span>` : ""}
        ${trades && !allTrades && trades.realizedCount > (trades.recent?.length ?? 0) ? `
          <button type="button" class="at-btn at-btn-ghost at-btn-tiny" data-at-action="load-all-trades" ${loadingAllTrades ? "disabled" : ""}>
            ${loadingAllTrades ? "불러오는 중…" : `전체 ${trades.realizedCount}건 보기`}
          </button>` : ""}
        ${allTrades ? `
          <button type="button" class="at-btn at-btn-ghost at-btn-tiny" data-at-action="collapse-trades">최근만 보기</button>` : ""}
      </div>
      ${trades && trades.recent?.length ? `
        <div class="at-table-scroll">
        <table class="at-table">
          <thead><tr><th>종목</th><th>수량</th><th>매수</th><th>매도</th>
            <th>총이익</th><th>비용</th><th>순익</th></tr></thead>
          <tbody>
            ${[...trades.recent].reverse().map((trade) => `
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
        </div>
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

  `;

  // 설정 폼은 DOM 노드를 그대로 유지한다(열려 있는 동안 통째로 다시 만들면 입력 중이던
  // 값과 커서가 날아간다). 그래서 폼은 열 때 딱 한 번만 만들고, 그 뒤로는 매 렌더마다
  // 필드 하나하나의 값만 최신 서버값으로 맞춘다(syncSettingsFields) — 사용자가 타이핑
  // 중이거나(draft) 지금 포커스가 있는 칸은 건드리지 않는다.
  // 한도(limits)는 자동매매 상태보다 늦게 도착하는 별도 요청이라, 폼을 열자마자는
  // 아직 없어 빈 칸으로 보일 수 있지만, 위 필드 동기화가 도착하는 대로 채워 넣는다.
  // 이 필드 단위 동기화가 없으면(2026-09-17: 폼을 한 번 만든 뒤로 다시는 갱신하지 않던
  // 이전 버전), 저장 직후에도 화면은 저장 전 값을 계속 보여줘 사용자에게는 "방금 바꾼
  // 값이 사라진 것"처럼 보였다.
  const openForm = panel.querySelector(":scope > .at-settings");
  if (showSettings && !openForm) {
    const form = document.createElement("div");
    form.className = "at-section at-settings";
    form.innerHTML = settingsHtml();
    panel.append(form);
  } else if (!showSettings && openForm) {
    openForm.remove();
  } else if (showSettings && openForm) {
    syncSettingsFields(openForm);
  }

  // app.js가 execution-grid를 다시 그릴 때마다 이 패널을 일단 그리드 안으로
  // 옮겨 붙여 놓지만, 혹시라도 다른 자리로 가 있으면 매 렌더마다 스스로 바로잡는다.
  if (panel.parentElement !== host) host.append(panel);
  restoreFocus();
}

// 재생성된 폼에 직전 커서 위치를 되돌린다. 없으면 아무것도 하지 않는다.
function restoreFocus() {
  if (!focusState) return;
  const input = document.getElementById(focusState.id);
  if (!input || document.activeElement === input) return;
  input.focus({ preventScroll: true });
  try {
    input.setSelectionRange(focusState.start, focusState.end);
  } catch { /* 선택 범위를 못 쓰는 입력은 무시 */ }
}

function captureFocus(input) {
  focusState = {
    id: input.id,
    start: input.selectionStart ?? input.value.length,
    end: input.selectionEnd ?? input.value.length,
  };
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

// 설정은 전부 화면에서 바꿀 수 있어야 한다. 검증 중에는 표본 수집 속도와
// 안전 한도를 자주 조절하게 되는데, 그때마다 .env를 고치고 재기동할 수는 없다.
const STRATEGY_FIELDS = [
  ["minimumNetEdgeBps", "최소 기대 순익", "bp", "비용을 다 빼고도 남아야 하는 크기"],
  ["positionSizeRatio", "진입 비중", "배", "자기자본 대비 (0.1 = 10%)"],
  ["takeProfitBps", "익절", "bp", ""],
  ["stopLossBps", "손절", "bp", ""],
  ["trailingStopBps", "트레일링 스톱", "bp", ""],
  ["maxHoldingMs", "최대 보유시간", "ms", "1800000 = 30분"],
  ["cooldownMs", "쿨다운", "ms", ""],
  ["maximumSpreadTicks", "최대 스프레드", "틱", ""],
  ["entryMinimumConfidence", "진입 확신도", "", ""],
  ["exitMinimumConfidence", "청산 확신도", "", ""],
  ["staleQuoteMs", "시세 지연 허용", "ms", ""],
  ["evaluationIntervalMs", "평가 주기", "ms", "15000 = 15초"],
  ["settlementGraceMs", "정산 대기", "ms", "주문 후 잔고 반영 대기"],
  ["forcedExitTime", "강제 청산 시각", "", "HH:MM, 비우면 안 함"],
];

const LIMIT_FIELDS = [
  ["maxDailyOrders", "일일 주문 한도", "건", "표본 수집 속도를 좌우"],
  ["maxConsecutiveLosses", "연속 손실 한도", "회", "0이면 해제. 낮으면 자주 멈춤"],
  ["maxDailyLoss", "일일 손실 한도", "원", "0이면 해제. 폭주 방지용으로 남겨두길 권장"],
  ["maxOrderQuantity", "1회 최대 수량", "주", ""],
  ["maxOrderValue", "1회 최대 금액", "원", ""],
];

function fieldRow(key, label, unit, hint, value, group) {
  const drafted = draft[group]?.[key];
  const source = drafted !== undefined ? drafted : value;
  const shown = source === null || source === undefined ? "" : source;
  return `<label class="at-field">
    <span>${escapeHtml(label)}${unit ? ` <em>${escapeHtml(unit)}</em>` : ""}</span>
    <input type="text" id="at-field-${group}-${escapeHtml(key)}"
      inputmode="${key === "forcedExitTime" ? "text" : "decimal"}"
      autocomplete="off" spellcheck="false"
      data-at-field="${escapeHtml(key)}" data-at-group="${group}"
      value="${escapeHtml(String(shown))}" />
    ${hint ? `<small>${escapeHtml(hint)}</small>` : ""}
  </label>`;
}

// 폼을 다시 만들지 않고 필드 값만 최신 서버값으로 맞춘다. 사용자가 지금 타이핑
// 중이거나(draft에 값이 있음) 포커스가 가 있는 칸은 건드리지 않는다 — 그 외에는
// 저장 직후나 다음 폴링에서 값이 바뀌어도 화면에 그대로 반영되게 한다.
function syncSettingsFields(form) {
  const strategy = status?.settings ?? {};
  for (const input of form.querySelectorAll("[data-at-field]")) {
    const key = input.dataset.atField;
    const group = input.dataset.atGroup === "limits" ? "limits" : "strategy";
    if (draft[group][key] !== undefined) continue;
    if (document.activeElement === input) continue;
    const source = group === "limits" ? limits?.[key] : strategy[key];
    const next = source === null || source === undefined ? "" : String(source);
    if (input.value !== next) input.value = next;
  }
}

function settingsHtml() {
  const strategy = status.settings ?? {};
  return `
    <div class="at-section-title">전략 설정</div>
    <div class="at-fields">
      ${STRATEGY_FIELDS.map(([k, l, u, h]) => fieldRow(k, l, u, h, strategy[k], "strategy")).join("")}
    </div>
    <div class="at-section-title" style="margin-top:12px">모의계좌 안전 한도</div>
    <div class="at-fields">
      ${LIMIT_FIELDS.map(([k, l, u, h]) => fieldRow(k, l, u, h, limits?.[k], "limits")).join("")}
    </div>
    <div class="at-save-row">
      <button type="button" class="at-btn at-btn-save" data-at-action="save" ${busy ? "disabled" : ""}>저장</button>
      <button type="button" class="at-btn at-btn-ghost" data-at-action="reload-settings">현재값 불러오기</button>
      <small>저장하면 즉시 적용됩니다. 재기동은 필요 없습니다.</small>
    </div>`;
}

// 입력값을 모아 전략 설정과 한도를 각각 저장한다. 빈 칸은 null(해제)로 보낸다.
async function saveSettings(panel) {
  const strategy = {};
  const nextLimits = {};
  for (const input of panel.querySelectorAll("[data-at-field]")) {
    const key = input.dataset.atField;
    const group = input.dataset.atGroup === "limits" ? "limits" : "strategy";
    const drafted = draft[group][key];
    const raw = String(drafted !== undefined ? drafted : input.value).trim();
    const target = group === "limits" ? nextLimits : strategy;
    if (raw === "") { target[key] = null; continue; }
    target[key] = key === "forcedExitTime" ? raw : Number(raw);
  }
  await api("/api/kis/paper/limits", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(nextLimits),
  });
  await api("/api/kis/paper/auto-trading", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(strategy),
  });
  message = { tone: "ok", text: "설정을 저장했습니다." };
  draft.strategy = {};
  draft.limits = {};
  focusState = null;
  await refresh();
}

// 입력할 때마다 초안과 커서를 기록한다. 폴링 렌더가 끼어들어도 값이 남는다.
document.addEventListener("input", (event) => {
  const input = event.target.closest?.("[data-at-field]");
  if (!input) return;
  const group = input.dataset.atGroup === "limits" ? "limits" : "strategy";
  draft[group][input.dataset.atField] = input.value;
  captureFocus(input);
});
document.addEventListener("focusin", (event) => {
  const input = event.target.closest?.("[data-at-field]");
  if (input) captureFocus(input);
});
document.addEventListener("focusout", (event) => {
  if (event.target.closest?.("[data-at-field]")) focusState = null;
});

app?.addEventListener("click", (event) => {
  const action = event.target.closest("[data-at-action]")?.dataset.atAction;
  if (!action) return;
  if (action === "start") void setEnabled(true);
  if (action === "stop") void setEnabled(false);
  if (action === "release") void releaseHalt();
  if (action === "settings") { showSettings = !showSettings; render(); }
  if (action === "save") {
    const panel = event.target.closest(".auto-trading-panel");
    if (panel) void run(() => saveSettings(panel));
  }
  if (action === "reload-settings") {
    draft.strategy = {};
    draft.limits = {};
    focusState = null;
    render();
  }
  if (action === "dismiss") { message = null; render(); }
  if (action === "load-all-trades") void loadAllTrades();
  if (action === "collapse-trades") { allTrades = null; render(); }
});

// 폴링에 쓰는 /performance 호출은 20건으로 가볍게 유지하고, 전체 내역은 사용자가
// 눌렀을 때만 한 번 더 요청해서 채운다 — 거래가 쌓일수록 매 3초 폴링 응답이
// 무한정 커지는 것을 막기 위함이다.
async function loadAllTrades() {
  loadingAllTrades = true;
  render();
  try {
    const full = await api("/api/kis/paper/performance?recent=all");
    allTrades = full?.trades ?? null;
  } catch (error) {
    message = { tone: "error", text: error instanceof Error ? error.message : String(error) };
  } finally {
    loadingAllTrades = false;
    render();
  }
}

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
    .at-btn{border-radius:8px;padding:10px 16px;font-size:11px;cursor:pointer;border:1px solid transparent}
    .at-btn[disabled]{opacity:.5;cursor:not-allowed}
    .at-btn-start{background:#4be0aa;border:0;color:#06110e;font-weight:800}
    .at-btn-stop{background:#ff6d89;border:0;color:#21060d;font-weight:800}
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
    .at-btn-tiny{padding:2px 9px;font-size:9px;margin-left:auto}
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
    .at-table-scroll{max-height:280px;overflow-y:auto}
    .at-table{width:100%;border-collapse:collapse;font-size:11px}
    .at-table thead th{position:sticky;top:0;background:#0c1722}
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
    .at-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
    .at-field{display:flex;flex-direction:column;gap:3px}
    .at-field span{font-size:10px;color:#8fa9bd}
    .at-field em{font-style:normal;color:#5d7385}
    .at-field input{background:#0a141d;border:1px solid #1c344a;border-radius:6px;color:#dbeeff;padding:6px 8px;font-size:12px;width:100%;box-sizing:border-box}
    .at-field input:focus{outline:none;border-color:#3d7ba8}
    .at-field small{font-size:9px;color:#5d7385}
    .at-save-row{display:flex;align-items:center;gap:10px;margin-top:12px}
    .at-btn-save{background:#1d5c8a;border-color:#2e7fb5;color:#eaf6ff;font-weight:600}
    .at-save-row small{font-size:10px;color:#5d7385}
    .at-ok{background:#0f2a1c;border:1px solid #2e7a52;color:#9fe3c0}
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
