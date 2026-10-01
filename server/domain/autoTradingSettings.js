// 모의계좌 자동매매 설정 (docs/AUTO_TRADING_PAPER_DESIGN.md)
//
// 수수료·세금·슬리피지 같은 비용 항목은 여기서 다시 정의하지 않는다.
// recommendationSettings의 비용 모델을 단일 출처로 사용해 두 곳이 어긋나지 않게 한다.

export const DEFAULT_AUTO_TRADING_SETTINGS = Object.freeze({
  schemaVersion: 1,
  // 자동매매는 기본으로 꺼져 있다. 명시적으로 켜야만 주문이 나간다.
  enabled: false,
  // 비용을 모두 뺀 뒤에도 남아야 하는 최소 기대 순익. 이 문턱을 넘지 못하면 진입하지 않는다.
  minimumNetEdgeBps: 50,
  // 자기자본 대비 1회 진입 비중. 실제 수량은 모의계좌 한도로 다시 잘린다.
  // 동시에 최대 maxConcurrentPositions개를 들고 갈 수 있으므로, 전부 채워지면
  // 최대 노출은 positionSizeRatio × maxConcurrentPositions다(기본값 기준 0.1×5=50%).
  positionSizeRatio: 0.1,
  // 동시 보유 가능한 종목 수. 원래 1이었다 — 좋은 신호가 떠도 이미 다른 종목을
  // 들고 있으면 그냥 놓쳤다. 진입 문턱(ENTRY_READY)은 그대로 두고 거래 기회만
  // 넓히기 위해 5로 올린다(2026-09-23).
  maxConcurrentPositions: 5,
  entryMinimumConfidence: 50,
  exitMinimumConfidence: 50,
  maximumSpreadTicks: 2,
  cooldownMs: 5_000,
  // 보호 청산. null이면 해당 청산을 쓰지 않는다.
  stopLossBps: 100,
  takeProfitBps: 150,
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
  trailingStopBps: 100,
  // armed된 뒤 고점 밑으로 내려온 상태가 이 시간만큼 유지돼야 진짜 하락으로
  // 인정한다(0=유예 없이 즉시). 실시간 틱으로 더 자주 확인하게 되면서
  // (kisPaperAutoTrader.js의 realtimeClient 연동, 2026-09-23) 찰나의 호가
  // 흔들림 하나에 바로 팔리는 걸 막는 debounce다.
  trailingConfirmMs: 1_500,
  maxHoldingMs: 1_800_000,
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
  "stopLossBps",
  "takeProfitBps",
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
    stopLossBps: env.PULSEHFT_AUTO_TRADING_STOP_LOSS_BPS,
    takeProfitBps: env.PULSEHFT_AUTO_TRADING_TAKE_PROFIT_BPS,
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
    stopLossBps: nullableNumberInRange(merged.stopLossBps, 1, 10_000, "stopLossBps"),
    takeProfitBps: nullableNumberInRange(merged.takeProfitBps, 1, 10_000, "takeProfitBps"),
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
