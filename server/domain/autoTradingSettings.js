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
  positionSizeRatio: 0.1,
  entryMinimumConfidence: 50,
  exitMinimumConfidence: 50,
  maximumSpreadTicks: 2,
  cooldownMs: 5_000,
  // 보호 청산. null이면 해당 청산을 쓰지 않는다.
  stopLossBps: 100,
  takeProfitBps: 150,
  trailingStopBps: 70,
  maxHoldingMs: 1_800_000,
  // 장 종료 전 강제 청산 시각(KST, HH:MM). null이면 강제 청산하지 않는다.
  forcedExitTime: "15:15",
  // 호가·체결이 이 시간보다 오래되면 신규 진입을 막는다. 보호 청산은 계속 동작한다.
  staleQuoteMs: 5_000,
  // 평가 주기. 추천 스캐너 캐시 TTL(기본 15초)과 맞춰 불필요한 잔고 조회를 줄인다.
  evaluationIntervalMs: 15_000,
  // 주문 상태가 불확실하거나 대사가 어긋나면 자동매매를 멈춘다.
  haltOnUnknownResult: true,
  haltOnReconciliationMismatch: true,
});

const EDITABLE_KEYS = Object.freeze([
  "enabled",
  "minimumNetEdgeBps",
  "positionSizeRatio",
  "entryMinimumConfidence",
  "exitMinimumConfidence",
  "maximumSpreadTicks",
  "cooldownMs",
  "stopLossBps",
  "takeProfitBps",
  "trailingStopBps",
  "maxHoldingMs",
  "forcedExitTime",
  "staleQuoteMs",
  "evaluationIntervalMs",
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
    entryMinimumConfidence: env.PULSEHFT_AUTO_TRADING_ENTRY_MIN_CONFIDENCE,
    exitMinimumConfidence: env.PULSEHFT_AUTO_TRADING_EXIT_MIN_CONFIDENCE,
    maximumSpreadTicks: env.PULSEHFT_AUTO_TRADING_MAX_SPREAD_TICKS,
    cooldownMs: env.PULSEHFT_AUTO_TRADING_COOLDOWN_MS,
    stopLossBps: env.PULSEHFT_AUTO_TRADING_STOP_LOSS_BPS,
    takeProfitBps: env.PULSEHFT_AUTO_TRADING_TAKE_PROFIT_BPS,
    trailingStopBps: env.PULSEHFT_AUTO_TRADING_TRAILING_STOP_BPS,
    maxHoldingMs: env.PULSEHFT_AUTO_TRADING_MAX_HOLDING_MS,
    forcedExitTime: env.PULSEHFT_AUTO_TRADING_FORCED_EXIT_TIME,
    staleQuoteMs: env.PULSEHFT_AUTO_TRADING_STALE_QUOTE_MS,
    evaluationIntervalMs: env.PULSEHFT_AUTO_TRADING_EVALUATION_INTERVAL_MS,
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
    entryMinimumConfidence: numberInRange(merged.entryMinimumConfidence, 0, 100, "entryMinimumConfidence"),
    exitMinimumConfidence: numberInRange(merged.exitMinimumConfidence, 0, 100, "exitMinimumConfidence"),
    maximumSpreadTicks: integerInRange(merged.maximumSpreadTicks, 0, 100, "maximumSpreadTicks"),
    cooldownMs: integerInRange(merged.cooldownMs, 0, 3_600_000, "cooldownMs"),
    stopLossBps: nullableNumberInRange(merged.stopLossBps, 1, 10_000, "stopLossBps"),
    takeProfitBps: nullableNumberInRange(merged.takeProfitBps, 1, 10_000, "takeProfitBps"),
    trailingStopBps: nullableNumberInRange(merged.trailingStopBps, 1, 10_000, "trailingStopBps"),
    maxHoldingMs: nullableIntegerInRange(merged.maxHoldingMs, 1_000, 86_400_000, "maxHoldingMs"),
    forcedExitTime: forcedExitTimeValue(merged.forcedExitTime),
    staleQuoteMs: integerInRange(merged.staleQuoteMs, 100, 600_000, "staleQuoteMs"),
    evaluationIntervalMs: integerInRange(merged.evaluationIntervalMs, 1_000, 600_000, "evaluationIntervalMs"),
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
