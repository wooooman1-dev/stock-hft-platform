export const DEFAULT_STRATEGY_SETTINGS = Object.freeze({
  schemaVersion: 1,
  entryMinimumConfidence: 50,
  exitMinimumConfidence: 50,
  maximumSpreadTicks: 2,
  orderQuantity: 10,
  cooldownMs: 5_000,
  stopLossBps: null,
  takeProfitBps: null,
  trailingStopBps: null,
  maxHoldingMs: null,
});

const EDITABLE_KEYS = Object.freeze([
  "entryMinimumConfidence",
  "exitMinimumConfidence",
  "maximumSpreadTicks",
  "orderQuantity",
  "cooldownMs",
  "stopLossBps",
  "takeProfitBps",
  "trailingStopBps",
  "maxHoldingMs",
]);

export class StrategySettingsError extends Error {
  constructor(message, code = "INVALID_STRATEGY_SETTINGS") {
    super(message);
    this.name = "StrategySettingsError";
    this.statusCode = 400;
    this.code = code;
  }
}

export function normalizeStrategySettings(
  input = {},
  { base = DEFAULT_STRATEGY_SETTINGS, maxOrderQuantity = 100 } = {},
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new StrategySettingsError("전략 설정은 JSON 객체여야 합니다.");
  }

  const allowedKeys = new Set(["schemaVersion", ...EDITABLE_KEYS]);
  const unknownKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new StrategySettingsError(`지원하지 않는 전략 설정: ${unknownKeys.join(", ")}`);
  }

  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) {
    throw new StrategySettingsError("지원하지 않는 전략 설정 버전입니다.", "UNSUPPORTED_STRATEGY_SETTINGS_VERSION");
  }

  const merged = {
    ...DEFAULT_STRATEGY_SETTINGS,
    ...base,
    ...input,
    schemaVersion: 1,
  };

  return Object.freeze({
    schemaVersion: 1,
    entryMinimumConfidence: integerInRange(
      merged.entryMinimumConfidence,
      0,
      100,
      "진입 최소 신뢰도",
    ),
    exitMinimumConfidence: integerInRange(
      merged.exitMinimumConfidence,
      0,
      100,
      "청산 최소 신뢰도",
    ),
    maximumSpreadTicks: integerInRange(
      merged.maximumSpreadTicks,
      1,
      20,
      "최대 스프레드",
    ),
    orderQuantity: integerInRange(
      merged.orderQuantity,
      1,
      maxOrderQuantity,
      "진입 주문 수량",
    ),
    cooldownMs: integerInRange(
      merged.cooldownMs,
      1_000,
      600_000,
      "재진입 대기시간",
    ),
    stopLossBps: optionalIntegerInRange(
      merged.stopLossBps,
      1,
      10_000,
      "손절률",
    ),
    takeProfitBps: optionalIntegerInRange(
      merged.takeProfitBps,
      1,
      10_000,
      "익절률",
    ),
    trailingStopBps: optionalIntegerInRange(
      merged.trailingStopBps,
      1,
      10_000,
      "트레일링 스톱",
    ),
    maxHoldingMs: optionalSafeIntegerAtLeast(
      merged.maxHoldingMs,
      1_000,
      "최대 보유시간",
    ),
  });
}

export function editableStrategySettings(settings) {
  const normalized = normalizeStrategySettings(settings);
  return Object.fromEntries(EDITABLE_KEYS.map((key) => [key, normalized[key]]));
}

function integerInRange(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new StrategySettingsError(`${label}는 ${minimum} 이상 ${maximum} 이하의 정수여야 합니다.`);
  }
  return number;
}

function optionalIntegerInRange(value, minimum, maximum, label) {
  if (value === null) return null;
  return integerInRange(value, minimum, maximum, label);
}

function optionalSafeIntegerAtLeast(value, minimum, label) {
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new StrategySettingsError(`${label}는 ${minimum} 이상의 안전한 정수여야 합니다.`);
  }
  return number;
}
