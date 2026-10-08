// 모의계좌 자동매매 설정 (docs/AUTO_TRADING_PAPER_DESIGN.md)
//
// 수수료·세금·슬리피지 같은 비용 항목은 여기서 다시 정의하지 않는다.
// recommendationSettings의 비용 모델을 단일 출처로 사용해 두 곳이 어긋나지 않게 한다.

// schemaVersion 2 (2026-10-02): 036930 손실 분석으로 진입 필터(체결강도·VWAP·지속시간·
// 진입 금지 시간대·최소 손절 틱·손익비)와 손절 유예, 당일 연속 손실 제한을 추가하고
// 익절 기본값을 150 → 250bp로 올렸다.
const SCHEMA_VERSION = 2;

export const DEFAULT_AUTO_TRADING_SETTINGS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  // 자동매매는 기본으로 꺼져 있다. 명시적으로 켜야만 주문이 나간다.
  enabled: false,
  // 비용을 모두 뺀 뒤에도 남아야 하는 최소 기대 순익. 이 문턱을 넘지 못하면 진입하지 않는다.
  minimumNetEdgeBps: 50,
  // 자기자본 대비 1회 진입 비중. 실제 수량은 모의계좌 한도로 다시 잘린다.
  // 동시에 최대 maxConcurrentPositions개를 들고 갈 수 있으므로, 전부 채워지면
  // 최대 노출은 positionSizeRatio × maxConcurrentPositions다(기본값 기준 0.1×3=30%).
  positionSizeRatio: 0.1,
  // 동시 보유 가능한 종목 수. 원래 1이었다 — 좋은 신호가 떠도 이미 다른 종목을
  // 들고 있으면 그냥 놓쳤다. 진입 문턱(ENTRY_READY)은 그대로 두고 거래 기회만
  // 넓히기 위해 5로 올린다(2026-09-23).
  // 2026-10-08: 실전 자동매매 소액 시험과 같은 3종목으로 맞췄다(예전 기본값 5).
  maxConcurrentPositions: 3,
  entryMinimumConfidence: 50,
  exitMinimumConfidence: 50,
  maximumSpreadTicks: 2,
  cooldownMs: 5_000,
  // ── 진입 필터 (2026-10-02) ──
  // 036930(주성엔지니어링)을 당일 VWAP -193bp·체결강도 91.8(매도 우위, 하락 중)·점심시간에
  // 2~3틱 반등 점수만 보고 샀다가 손절됐다. 아래 조건은 전부 자동매매 진입에만 적용된다.
  // 체결강도가 이 값 이상(100=매수·매도 체결이 같음)일 때만 진입한다. null이면 보지 않는다.
  // 2026-10-08 운영값(90)을 기본값에 맞췄다 — 설정 파일(.pulsehft)은 깃에 안 올라가서 다른 PC에서는 이 기본값이 곧 운영값이다.
  entryMinimumExecutionStrength: 90,
  // 당일 VWAP 대비 괴리가 이 값보다 낮으면(하락 추세) 진입하지 않는다. null이면 보지 않는다.
  entryMinimumVwapExtensionBps: -50,
  // 같은 종목이 ENTRY_READY로 이 시간 이상 연속 유지돼야 진입한다(한 순간 신호는 거른다).
  entryConfirmMs: 30_000,
  // 이 시간대(KST "HH:MM-HH:MM", 끝 시각 미포함)에는 신규 진입하지 않는다. 청산은 계속한다.
  // 14:45부터는 막는다: 고가 근처 모멘텀은 60분 보유가 전제인데(아래 maxHoldingMs), 14:45 이후 진입은
  // 15:15 강제 청산에 먼저 걸려 보유 가능 시간이 23분 이하이고 실제로도 평균 -16bp(승률 33%)였다.
  // 처음엔 14:15부터 막았지만(2026-10-07, "14:15 이후 평균 -2bp") 그건 14:15~14:45(+44bp, 승률 74%, 31건)와
  // 14:45~15:30(-16bp, 42건)을 합친 값이었다(2026-10-08 시간대별 재측정). 14:15 이후 표본은 적고 검증
  // 구간에는 하나도 없으니 데이터가 쌓이면 다시 잰다.
  noEntryWindows: Object.freeze(["09:00-09:10", "11:30-13:00", "14:45-15:30"]),
  // 손절폭이 그 종목 호가단위로 이 틱 수보다 좁으면 진입하지 않는다(고가주는 손절이 노이즈 몇 틱에 걸린다).
  minimumStopTicks: 6,
  // (익절 - 비용 - 스프레드) ÷ (손절 + 비용 + 스프레드)가 이 값 이상이어야 진입한다.
  minimumRewardRiskRatio: 1.5,
  // 오늘 실현손실(비용 차감 후) 매매가 이 횟수만큼 연속되면 그날 신규 진입을 멈춘다(0=끔).
  // 주문 서비스의 연속 손실 한도는 킬 스위치를 켜 보호 청산까지 막으므로 쓰지 않고 여기서 거른다.
  // 2026-10-08 운영값(0=끔)을 기본값에 맞췄다.
  maxConsecutiveLossesPerDay: 0,
  // 보호 청산. null이면 해당 청산을 쓰지 않는다.
  // 2026-10-07 신호 단위 측정(고가 근처 모멘텀, 같은 종목 10분 중복 제거 488건): 60분 보유 기준
  // 손절 100/150이면 평균이 오히려 낮았고(손절 150: +15.7bp) 손절 300은 +23.1bp로 손절 없음
  // (+23.5bp)과 같았다 — 100bp 안팎 손절은 정상적인 흔들림에 걸려 이익을 깎는다. 300은 최악
  // 손실(-732bp → -419bp)만 막는 비상 손절이다.
  stopLossBps: 300,
  // 150이었을 때는 비용·스프레드를 빼면 손절과 손익비가 약 1:1이라 승률이 50%를 넘어야
  // 본전이었다(2026-10-02). 손절 100 기준 손익비가 1.5 이상 나오도록 올린다.
  // 익절/트레일링은 같은 측정에서 평균을 낮췄다(익절 400 +16.8bp, 트레일링 +10.9~16.5bp,
  // 손절 없이 60분 보유 +23.5bp). 익절 목표는 진입 비용 판정(순기대수익·손익비)에만 쓰이므로 사실상
  // 닿지 않는 값으로 둔다.
  takeProfitBps: 1_000,
  // 손절선 아래에 이 시간만큼 머물러야 손절한다(손절폭 2배 이상 빠지면 즉시).
  stopConfirmMs: 2_000,
  // "고점 대비 X% 빠지면 판다"가 아니라 "진입가 대비 X% 이상 오른 적이 있으면
  // (armed) 그 뒤 신고점을 못 찍고 조금이라도 빠지는 순간 즉시 판다"는 뜻이다
  // (strategyPolicy.js, 2026-09-23 변경). 그래서 이 숫자는 "얼마나 밀리면
  // 파는가"가 아니라 "얼마나 올라야 이 보호를 켤 것인가"다. 처음엔 왕복비용
  // (약 23bp) 대비 여유만 두고 35bp로 뒀는데, 실측 21건(2026-09-23)을 대조해보니
  // TRAILING_STOP 청산이 평균 순손실(-7.1bp 총수익 기준)이었고, 보호청산 개입
  // 없이 최대보유시간까지 그냥 들고 간 MAX_HOLDING_TIME만 유일하게 순이익
  // (+43.9bp)이었다 — armed 문턱이 너무 낮아 이익을 조기에 잘라내고 있었다는
  // 뜻이다. 손절폭(stopLossBps)과 같은 수준으로 올려 "이익 거래"와 "손실 거래"의
  // 크기를 맞춘다(armed 이후 즉시매도 메커니즘 자체는 그대로).
  // 같은 측정에서 트레일링은 60분 보유보다 평균이 낮아 끈다(null).
  trailingStopBps: null,
  // armed된 뒤 고점 밑으로 내려온 상태가 이 시간만큼 유지돼야 진짜 하락으로
  // 인정한다(0=유예 없이 즉시). 실시간 틱으로 더 자주 확인하게 되면서
  // (kisPaperAutoTrader.js의 realtimeClient 연동, 2026-09-23) 찰나의 호가
  // 흔들림 하나에 바로 팔리는 걸 막는 debounce다.
  trailingConfirmMs: 1_500,
  // 신호 측정에서 5~10분 보유는 비용(23bp)에 먹히고 60분 보유가 가장 나았다.
  maxHoldingMs: 3_600_000,
  // 장 종료 전 강제 청산 시각(KST, HH:MM). null이면 강제 청산하지 않는다.
  forcedExitTime: "15:15",
  // 호가·체결이 이 시간보다 오래되면 신규 진입을 막는다. 보호 청산은 계속 동작한다.
  staleQuoteMs: 5_000,
  // 평가 주기. checkEntryGate는 이 주기마다 딱 한 순간의 realtime.state만 보고
  // 판단한다(대기 개념 없음) — 15초였을 때 좋은 종목(WATCH/ENTRY_READY)이 두
  // 평가 사이(예: REALTIME_CONFIRMING으로 잠깐 머무는 순간)에 왔다 가면 그냥
  // 놓쳤다(2026-09-18, 실제 평가 로그로 확인: 15초 표본에서 15개 후보 전부
  // REALTIME_CONFIRMING이었는데 16초 뒤 재조회하니 1위 후보가 진입 확신도
  // 84.6점짜리 WATCH로 바뀌어 있었다). 추천 스캐너 캐시 TTL(15초)과는 무관하다
  // — realtime.state는 캐시와 별개로 매 호출마다 웹소켓 최신값으로 재계산되므로
  // 평가를 더 자주 해도 스캐너 재조회가 늘지 않는다. 모의투자 잔고조회 1건/5초는
  // KIS 한도(초당 1건)에 여유 있다.
  evaluationIntervalMs: 5_000,
  // 주문 후 잔고에 반영되기까지 기다리는 시간. 이 구간에는 "보유 없음"을 믿지 않는다.
  // 60초로는 부족했다 — 2026-09-18에 정상 주문이 실제 체결 확인까지 약 100초
  // 걸린 사례를 저널로 확인했다. 그보다 짧으면 아직 반영 안 된 포지션에 또
  // 진입을 시도해 중복매수로 이어질 수 있어(2026-09-11 전례) 여유 있게 올린다.
  settlementGraceMs: 180_000,
  // 주문 상태가 불확실하거나 대사가 어긋나면 자동매매를 멈춘다.
  haltOnUnknownResult: true,
  haltOnReconciliationMismatch: true,
});

const EDITABLE_KEYS = Object.freeze([
  "enabled",
  "minimumNetEdgeBps",
  "positionSizeRatio",
  "maxConcurrentPositions",
  "entryMinimumConfidence",
  "exitMinimumConfidence",
  "maximumSpreadTicks",
  "cooldownMs",
  "entryMinimumExecutionStrength",
  "entryMinimumVwapExtensionBps",
  "entryConfirmMs",
  "noEntryWindows",
  "minimumStopTicks",
  "minimumRewardRiskRatio",
  "maxConsecutiveLossesPerDay",
  "stopLossBps",
  "takeProfitBps",
  "stopConfirmMs",
  "trailingStopBps",
  "trailingConfirmMs",
  "maxHoldingMs",
  "forcedExitTime",
  "staleQuoteMs",
  "evaluationIntervalMs",
  "settlementGraceMs",
  "haltOnUnknownResult",
  "haltOnReconciliationMismatch",
]);

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class AutoTradingSettingsError extends Error {
  constructor(message, code = "INVALID_AUTO_TRADING_SETTINGS") {
    super(message);
    this.name = "AutoTradingSettingsError";
    this.code = code;
    this.statusCode = 400;
  }
}

export function loadAutoTradingSettings(env = process.env) {
  return normalizeAutoTradingSettings({
    enabled: env.PULSEHFT_AUTO_TRADING_ENABLED,
    minimumNetEdgeBps: env.PULSEHFT_AUTO_TRADING_MIN_NET_EDGE_BPS,
    positionSizeRatio: env.PULSEHFT_AUTO_TRADING_POSITION_SIZE_RATIO,
    maxConcurrentPositions: env.PULSEHFT_AUTO_TRADING_MAX_CONCURRENT_POSITIONS,
    entryMinimumConfidence: env.PULSEHFT_AUTO_TRADING_ENTRY_MIN_CONFIDENCE,
    exitMinimumConfidence: env.PULSEHFT_AUTO_TRADING_EXIT_MIN_CONFIDENCE,
    maximumSpreadTicks: env.PULSEHFT_AUTO_TRADING_MAX_SPREAD_TICKS,
    cooldownMs: env.PULSEHFT_AUTO_TRADING_COOLDOWN_MS,
    entryMinimumExecutionStrength: env.PULSEHFT_AUTO_TRADING_ENTRY_MIN_EXECUTION_STRENGTH,
    entryMinimumVwapExtensionBps: env.PULSEHFT_AUTO_TRADING_ENTRY_MIN_VWAP_EXTENSION_BPS,
    entryConfirmMs: env.PULSEHFT_AUTO_TRADING_ENTRY_CONFIRM_MS,
    noEntryWindows: env.PULSEHFT_AUTO_TRADING_NO_ENTRY_WINDOWS,
    minimumStopTicks: env.PULSEHFT_AUTO_TRADING_MIN_STOP_TICKS,
    minimumRewardRiskRatio: env.PULSEHFT_AUTO_TRADING_MIN_REWARD_RISK_RATIO,
    maxConsecutiveLossesPerDay: env.PULSEHFT_AUTO_TRADING_MAX_CONSECUTIVE_LOSSES_PER_DAY,
    stopLossBps: env.PULSEHFT_AUTO_TRADING_STOP_LOSS_BPS,
    takeProfitBps: env.PULSEHFT_AUTO_TRADING_TAKE_PROFIT_BPS,
    stopConfirmMs: env.PULSEHFT_AUTO_TRADING_STOP_CONFIRM_MS,
    trailingStopBps: env.PULSEHFT_AUTO_TRADING_TRAILING_STOP_BPS,
    trailingConfirmMs: env.PULSEHFT_AUTO_TRADING_TRAILING_CONFIRM_MS,
    maxHoldingMs: env.PULSEHFT_AUTO_TRADING_MAX_HOLDING_MS,
    forcedExitTime: env.PULSEHFT_AUTO_TRADING_FORCED_EXIT_TIME,
    staleQuoteMs: env.PULSEHFT_AUTO_TRADING_STALE_QUOTE_MS,
    evaluationIntervalMs: env.PULSEHFT_AUTO_TRADING_EVALUATION_INTERVAL_MS,
    settlementGraceMs: env.PULSEHFT_AUTO_TRADING_SETTLEMENT_GRACE_MS,
    haltOnUnknownResult: env.PULSEHFT_AUTO_TRADING_HALT_ON_UNKNOWN,
    haltOnReconciliationMismatch: env.PULSEHFT_AUTO_TRADING_HALT_ON_MISMATCH,
  });
}

export function normalizeAutoTradingSettings(input = {}) {
  if (input === null || typeof input !== "object") {
    throw new AutoTradingSettingsError("자동매매 설정은 객체여야 합니다.");
  }
  const unknown = Object.keys(input).filter(
    (key) => key !== "schemaVersion" && !EDITABLE_KEYS.includes(key),
  );
  if (unknown.length > 0) {
    throw new AutoTradingSettingsError(`허용되지 않은 설정 항목입니다: ${unknown.join(", ")}`);
  }

  const merged = { ...DEFAULT_AUTO_TRADING_SETTINGS };
  for (const key of EDITABLE_KEYS) {
    if (input[key] !== undefined) merged[key] = input[key];
  }
  // v1로 저장된 설정 파일은 모든 값을 그대로 적어 두므로, 기본값을 바꿔도 v1 기본값
  // (익절 150)이 계속 덮어쓴다. v1 기본값 그대로인 항목만 새 기본값으로 올린다
  // — 사용자가 직접 바꾼 값은 건드리지 않는다.
  if (Number(input.schemaVersion) === 1 && Number(merged.takeProfitBps) === 150) {
    merged.takeProfitBps = DEFAULT_AUTO_TRADING_SETTINGS.takeProfitBps;
  }

  return Object.freeze({
    schemaVersion: DEFAULT_AUTO_TRADING_SETTINGS.schemaVersion,
    enabled: booleanValue(merged.enabled, "enabled"),
    minimumNetEdgeBps: numberInRange(merged.minimumNetEdgeBps, 0, 10_000, "minimumNetEdgeBps"),
    positionSizeRatio: ratioValue(merged.positionSizeRatio, "positionSizeRatio"),
    maxConcurrentPositions: integerInRange(merged.maxConcurrentPositions, 1, 10, "maxConcurrentPositions"),
    entryMinimumConfidence: numberInRange(merged.entryMinimumConfidence, 0, 100, "entryMinimumConfidence"),
    exitMinimumConfidence: numberInRange(merged.exitMinimumConfidence, 0, 100, "exitMinimumConfidence"),
    maximumSpreadTicks: integerInRange(merged.maximumSpreadTicks, 0, 100, "maximumSpreadTicks"),
    cooldownMs: integerInRange(merged.cooldownMs, 0, 3_600_000, "cooldownMs"),
    entryMinimumExecutionStrength: nullableNumberInRange(
      merged.entryMinimumExecutionStrength, 0, 1_000, "entryMinimumExecutionStrength",
    ),
    entryMinimumVwapExtensionBps: nullableNumberInRange(
      merged.entryMinimumVwapExtensionBps, -10_000, 10_000, "entryMinimumVwapExtensionBps",
    ),
    entryConfirmMs: integerInRange(merged.entryConfirmMs, 0, 600_000, "entryConfirmMs"),
    noEntryWindows: timeWindowsValue(merged.noEntryWindows),
    minimumStopTicks: integerInRange(merged.minimumStopTicks, 0, 100, "minimumStopTicks"),
    minimumRewardRiskRatio: numberInRange(merged.minimumRewardRiskRatio, 0, 20, "minimumRewardRiskRatio"),
    maxConsecutiveLossesPerDay: integerInRange(
      merged.maxConsecutiveLossesPerDay, 0, 100, "maxConsecutiveLossesPerDay",
    ),
    stopLossBps: nullableNumberInRange(merged.stopLossBps, 1, 10_000, "stopLossBps"),
    takeProfitBps: nullableNumberInRange(merged.takeProfitBps, 1, 10_000, "takeProfitBps"),
    stopConfirmMs: integerInRange(merged.stopConfirmMs, 0, 60_000, "stopConfirmMs"),
    trailingStopBps: nullableNumberInRange(merged.trailingStopBps, 1, 10_000, "trailingStopBps"),
    trailingConfirmMs: integerInRange(merged.trailingConfirmMs, 0, 60_000, "trailingConfirmMs"),
    maxHoldingMs: nullableIntegerInRange(merged.maxHoldingMs, 1_000, 86_400_000, "maxHoldingMs"),
    forcedExitTime: forcedExitTimeValue(merged.forcedExitTime),
    staleQuoteMs: integerInRange(merged.staleQuoteMs, 100, 600_000, "staleQuoteMs"),
    evaluationIntervalMs: integerInRange(merged.evaluationIntervalMs, 1_000, 600_000, "evaluationIntervalMs"),
    settlementGraceMs: integerInRange(merged.settlementGraceMs, 0, 600_000, "settlementGraceMs"),
    haltOnUnknownResult: booleanValue(merged.haltOnUnknownResult, "haltOnUnknownResult"),
    haltOnReconciliationMismatch: booleanValue(
      merged.haltOnReconciliationMismatch,
      "haltOnReconciliationMismatch",
    ),
  });
}

// 익절 목표가 비용과 문턱의 합을 넘지 못하면 어떤 국면에서도 진입이 성립하지 않는다.
// 조용히 거래가 0건이 되는 대신 배선 시점에 설정 오류로 드러낸다.
export function assertTradeableConfiguration(settings, costModel = {}) {
  const takeProfitBps = settings?.takeProfitBps;
  if (takeProfitBps === null || takeProfitBps === undefined) return;
  const fixedCostBps = fixedCost(costModel);
  const required = Number(settings.minimumNetEdgeBps) + fixedCostBps;
  if (takeProfitBps <= required) {
    throw new AutoTradingSettingsError(
      `익절 목표 ${takeProfitBps}bp가 최소 순익 문턱 ${settings.minimumNetEdgeBps}bp와 `
      + `고정비용 ${fixedCostBps.toFixed(2)}bp의 합 ${required.toFixed(2)}bp 이하입니다. `
      + "이 설정으로는 진입이 성립하지 않습니다.",
      "AUTO_TRADING_UNREACHABLE_TARGET",
    );
  }
}

// 진입 가능 여부 판정에 쓰는 기대 순익. 스프레드와 슬리피지는 진입 시점 실측을 받는다.
export function calculateExpectedNetEdgeBps({
  takeProfitBps,
  costModel = {},
  spreadBps = 0,
  slippageBps = 0,
}) {
  const target = Number(takeProfitBps);
  if (!Number.isFinite(target)) return null;
  return target - fixedCost(costModel) - Math.max(0, Number(spreadBps) || 0)
    - Math.max(0, Number(slippageBps) || 0);
}

// 손익비: 익절에 닿았을 때 남는 순익 ÷ 손절에 닿았을 때 잃는 순손실.
// 진입 때 스프레드만큼 불리하게 사므로 양쪽에 스프레드를 한 번씩 반영한다.
export function calculateRewardRiskRatio({
  takeProfitBps,
  stopLossBps,
  costModel = {},
  spreadBps = 0,
}) {
  const target = Number(takeProfitBps);
  const stop = Number(stopLossBps);
  if (takeProfitBps === null || stopLossBps === null || !Number.isFinite(target) || !Number.isFinite(stop)) {
    return null;
  }
  const spread = Math.max(0, Number(spreadBps) || 0);
  const reward = target - fixedCost(costModel) - spread;
  const risk = stop + fixedCost(costModel) + spread;
  return risk > 0 ? reward / risk : null;
}

// "HH:MM-HH:MM" 시간대 안이면(시작 포함, 끝 미포함) 그 문자열을 돌려준다.
export function matchingTimeWindow(windows, timestamp) {
  if (!Array.isArray(windows) || windows.length === 0) return null;
  const kst = new Date(Number(timestamp) + 9 * 60 * 60 * 1_000);
  const minutesNow = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  for (const window of windows) {
    const [start, end] = window.split("-").map(minutesOfDay);
    if (minutesNow >= start && minutesNow < end) return window;
  }
  return null;
}

function minutesOfDay(text) {
  const [hour, minute] = text.split(":").map(Number);
  return hour * 60 + minute;
}

function timeWindowsValue(value) {
  if (value === null || value === undefined || value === "") return Object.freeze([]);
  const list = Array.isArray(value) ? value : String(value).split(",");
  const windows = list.map((item) => String(item).trim()).filter(Boolean);
  for (const window of windows) {
    const [start, end, extra] = window.split("-");
    if (extra !== undefined || !TIME_PATTERN.test(start ?? "") || !TIME_PATTERN.test(end ?? "")
      || minutesOfDay(start) >= minutesOfDay(end)) {
      throw new AutoTradingSettingsError(
        `noEntryWindows의 "${window}"는 "HH:MM-HH:MM"(시작 < 끝) 형식이어야 합니다.`,
      );
    }
  }
  return Object.freeze(windows);
}

function fixedCost(costModel) {
  return (Number(costModel.buyCommissionBps) || 0)
    + (Number(costModel.sellCommissionBps) || 0)
    + (Number(costModel.sellTaxBps) || 0);
}

function booleanValue(value, label) {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "true") return true;
  if (text === "false" || text === "") return DEFAULT_AUTO_TRADING_SETTINGS[label];
  throw new AutoTradingSettingsError(`${label}은 true 또는 false여야 합니다.`);
}

function numberInRange(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new AutoTradingSettingsError(`${label}은 ${minimum} 이상 ${maximum} 이하의 수여야 합니다.`);
  }
  return number;
}

function ratioValue(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1) {
    throw new AutoTradingSettingsError(`${label}은 0 초과 1 이하의 비율이어야 합니다.`);
  }
  return number;
}

function integerInRange(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new AutoTradingSettingsError(`${label}은 ${minimum} 이상 ${maximum} 이하의 정수여야 합니다.`);
  }
  return number;
}

function nullableNumberInRange(value, minimum, maximum, label) {
  if (value === null || value === "" || value === undefined) return null;
  return numberInRange(value, minimum, maximum, label);
}

function nullableIntegerInRange(value, minimum, maximum, label) {
  if (value === null || value === "" || value === undefined) return null;
  return integerInRange(value, minimum, maximum, label);
}

function forcedExitTimeValue(value) {
  if (value === null || value === "" || value === undefined) return null;
  const text = String(value).trim();
  if (!TIME_PATTERN.test(text)) {
    throw new AutoTradingSettingsError('forcedExitTime은 "HH:MM" 형식이거나 null이어야 합니다.');
  }
  return text;
}
