const SETTINGS_ENDPOINT = "/api/strategy/settings";
const FIELD_IDS = Object.freeze({
  entryMinimumConfidence: "strategy-entry-confidence",
  exitMinimumConfidence: "strategy-exit-confidence",
  maximumSpreadTicks: "strategy-max-spread",
  orderQuantity: "strategy-order-quantity",
  cooldownSeconds: "strategy-cooldown-seconds",
});

let settings = null;
let draft = null;
let statusMessage = "";
let statusTone = "neutral";
let requestInFlight = false;
let loadStarted = false;

export function settingsToDraft(value) {
  return {
    entryMinimumConfidence: String(value.entryMinimumConfidence),
    exitMinimumConfidence: String(value.exitMinimumConfidence),
    maximumSpreadTicks: String(value.maximumSpreadTicks),
    orderQuantity: String(value.orderQuantity),
    cooldownSeconds: String(value.cooldownMs / 1_000),
  };
}

export function draftToPayload(value) {
  return {
    entryMinimumConfidence: parseInteger(value.entryMinimumConfidence, 0, 100, "진입 신뢰도"),
    exitMinimumConfidence: parseInteger(value.exitMinimumConfidence, 0, 100, "청산 신뢰도"),
    maximumSpreadTicks: parseInteger(value.maximumSpreadTicks, 1, 20, "최대 스프레드"),
    orderQuantity: parseInteger(value.orderQuantity, 1, 100, "진입 수량"),
    cooldownMs: parseInteger(value.cooldownSeconds, 1, 600, "재진입 대기시간") * 1_000,
  };
}

export function describeAutoStrategy(value) {
  if (!value) return "전략 설정을 불러오는 중";
  return `진입 ${value.entryMinimumConfidence}% · 청산 ${value.exitMinimumConfidence}% · 최대 ${value.maximumSpreadTicks}틱 · ${value.orderQuantity}주 · ${value.cooldownMs / 1_000}초 대기`;
}

export function setTextContentIfChanged(element, nextText) {
  if (!element || element.textContent === nextText) return false;
  element.textContent = nextText;
  return true;
}

function parseInteger(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label}는 ${minimum} 이상 ${maximum} 이하의 정수여야 합니다.`);
  }
  return number;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? `요청 실패 (${response.status})`);
  return payload;
}

function panelHtml() {
  if (!draft) {
    return `<section class="strategy-settings-panel" data-strategy-settings-panel><div class="strategy-settings-heading"><div><span>자동전략 설정</span><strong>불러오는 중</strong></div></div></section>`;
  }
  return `<section class="strategy-settings-panel" data-strategy-settings-panel>
    <div class="strategy-settings-heading">
      <div><span>자동전략 설정</span><strong>신호 조건과 진입 수량</strong></div>
      <div class="strategy-settings-actions">
        <button type="button" data-strategy-action="reset" ${requestInFlight ? "disabled" : ""}>기본값</button>
        <button type="button" class="primary" data-strategy-action="save" ${requestInFlight ? "disabled" : ""}>저장</button>
      </div>
    </div>
    <div class="strategy-settings-grid">
      ${field("진입 신뢰도", FIELD_IDS.entryMinimumConfidence, draft.entryMinimumConfidence, 0, 100, "%")}
      ${field("청산 신뢰도", FIELD_IDS.exitMinimumConfidence, draft.exitMinimumConfidence, 0, 100, "%")}
      ${field("최대 스프레드", FIELD_IDS.maximumSpreadTicks, draft.maximumSpreadTicks, 1, 20, "틱")}
      ${field("진입 수량", FIELD_IDS.orderQuantity, draft.orderQuantity, 1, 100, "주")}
      ${field("재진입 대기", FIELD_IDS.cooldownSeconds, draft.cooldownSeconds, 1, 600, "초")}
    </div>
    <p class="strategy-settings-status ${statusTone}">${statusMessage || "설정만 저장되며 자동전략은 서버 재시작 시 항상 꺼진 상태로 시작합니다."}</p>
  </section>`;
}

function field(label, id, value, min, max, suffix) {
  return `<label><span>${label}</span><div><input id="${id}" type="number" min="${min}" max="${max}" step="1" value="${value}"><small>${suffix}</small></div></label>`;
}

function mountPanel() {
  const systemPanel = document.querySelector(".system-panel");
  if (!systemPanel) return;
  if (!systemPanel.querySelector("[data-strategy-settings-panel]")) {
    const executionModel = systemPanel.querySelector(".execution-model");
    if (executionModel) executionModel.insertAdjacentHTML("afterend", panelHtml());
    else systemPanel.insertAdjacentHTML("afterbegin", panelHtml());
  }
  updateAutoDescription(systemPanel);
}

function updateAutoDescription(systemPanel) {
  if (!settings) return;
  for (const row of systemPanel.querySelectorAll(".control-row")) {
    if (row.querySelector("strong")?.textContent.trim() !== "모의 자동전략") continue;
    const description = row.querySelector("span");
    setTextContentIfChanged(description, describeAutoStrategy(settings));
  }
}

function replacePanel() {
  document.querySelector("[data-strategy-settings-panel]")?.remove();
  mountPanel();
}

async function loadSettings() {
  if (loadStarted) return;
  loadStarted = true;
  try {
    settings = await request(SETTINGS_ENDPOINT);
    draft = settingsToDraft(settings);
  } catch (error) {
    statusTone = "error";
    statusMessage = error instanceof Error ? error.message : "전략 설정을 불러오지 못했습니다.";
  }
  replacePanel();
}

async function saveSettings() {
  if (requestInFlight || !draft) return;
  try {
    requestInFlight = true;
    statusMessage = "저장 중…";
    statusTone = "neutral";
    replacePanel();
    const payload = draftToPayload(draft);
    settings = await request(SETTINGS_ENDPOINT, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    draft = settingsToDraft(settings);
    statusMessage = "저장 완료";
    statusTone = "success";
  } catch (error) {
    statusMessage = error instanceof Error ? error.message : "전략 설정 저장에 실패했습니다.";
    statusTone = "error";
  } finally {
    requestInFlight = false;
    replacePanel();
  }
}

async function resetSettings() {
  if (requestInFlight) return;
  try {
    requestInFlight = true;
    statusMessage = "기본값 복원 중…";
    statusTone = "neutral";
    replacePanel();
    settings = await request(`${SETTINGS_ENDPOINT}/reset`, { method: "POST", body: "{}" });
    draft = settingsToDraft(settings);
    statusMessage = "기본값으로 복원했습니다.";
    statusTone = "success";
  } catch (error) {
    statusMessage = error instanceof Error ? error.message : "기본값 복원에 실패했습니다.";
    statusTone = "error";
  } finally {
    requestInFlight = false;
    replacePanel();
  }
}

function handleInput(event) {
  if (!draft) return;
  const entry = Object.entries(FIELD_IDS).find(([, id]) => id === event.target?.id);
  if (!entry) return;
  draft[entry[0]] = event.target.value;
}

function startBrowserPanel() {
  const app = document.querySelector("#app");
  if (!app) return;
  const observer = new MutationObserver(mountPanel);
  observer.observe(app, { childList: true, subtree: true });
  document.addEventListener("input", handleInput);
  document.addEventListener("click", (event) => {
    const action = event.target.closest("[data-strategy-action]")?.dataset.strategyAction;
    if (action === "save") void saveSettings();
    if (action === "reset") void resetSettings();
  });
  mountPanel();
  void loadSettings();
}

if (typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
  startBrowserPanel();
}
