// maxUniverse/maxEnriched는 원래 각각 30/8이었다. 실시간으로 정밀 확인하는
// 종목이 8개뿐이면 그중 매수 조건을 동시에 만족하는 종목이 거의 안 나와서
// 자동매매가 하루 종일 몇 건 못 냈다(2026-09-17). 실시간 구독 한도(최대 20개,
// kisRealtimeMarketDataClient.js)에 여유를 두면서 후보군을 넓히기 위해 올렸다.
// 2026-09-23: WATCH 단계의 확신도 완화를 되돌리면서(진입 품질 문제로 9연패)
// 다시 좁아진 진입 기회를 품질을 낮추지 않고 넓히려고 15→18로 한 번 더 올린다
// — ENTRY_READY 판정 대상 종목 자체를 늘려서, "동시에 다 맞는 순간"이 나올 후보를
// 넓히는 쪽이다. 20(구독 한도)까지 채우면 정밀분석 한 바퀴(요청 간격 1초 기준
// 약 19초)가 캐시 주기(15초)를 넘어서므로 18에서 멈춘다.
export const DEFAULT_RECOMMENDATION_SETTINGS = Object.freeze({
  schemaVersion: 1,
  cacheTtlMs: 15_000,
  maxUniverse: 50,
  maxEnriched: 18,
  minimumTradingValue: 1_000_000_000,
  targetNetProfitBps: 300,
  buyCommissionBps: 1.40527,
  sellCommissionBps: 1.40527,
  sellTaxBps: 20,
  expectedSlippageTicks: 1,
  requestSpacingMs: 1_000,
  maximumDailyRisePercent: 15,
  maximumVwapExtensionBps: 500,
  maximumRecentRiseBps: 300,
  upperLimitProximityBps: 500,
  // ENTRY_READY 판정의 실시간 체결강도 문턱(realtimeConfirmationEngine.js). 100은
  // "매수 체결량이 매도 체결량과 같거나 더 많아야 함"이라 반전형 후보는 반등이
  // 막 시작된 순간엔 거의 못 넘었다(2026-09-23, 호가 불균형은 여유 있게 통과하는데
  // 체결강도만 못 넘어 8분간 20여 회 평가 전부 적격 후보 0건). 화면에서 조절할 수
  // 있도록 설정으로 뺀다.
  minimumExecutionStrength: 80,
});

export class RecommendationSettingsError extends Error {
  constructor(message, code = "INVALID_RECOMMENDATION_SETTINGS") {
    super(message);
    this.name = "RecommendationSettingsError";
    this.code = code;
    this.statusCode = 400;
  }
}

export function loadRecommendationSettings(env = process.env) {
  return normalizeRecommendationSettings({
    cacheTtlMs: env.PULSEHFT_RECOMMENDATION_CACHE_TTL_MS,
    maxUniverse: env.PULSEHFT_RECOMMENDATION_MAX_UNIVERSE,
    maxEnriched: env.PULSEHFT_RECOMMENDATION_MAX_ENRICHED,
    minimumTradingValue: env.PULSEHFT_RECOMMENDATION_MIN_TRADING_VALUE,
    targetNetProfitBps: env.PULSEHFT_RECOMMENDATION_TARGET_NET_BPS,
    buyCommissionBps: env.PULSEHFT_RECOMMENDATION_BUY_FEE_BPS,
    sellCommissionBps: env.PULSEHFT_RECOMMENDATION_SELL_FEE_BPS,
    sellTaxBps: env.PULSEHFT_RECOMMENDATION_SELL_TAX_BPS,
    expectedSlippageTicks: env.PULSEHFT_RECOMMENDATION_SLIPPAGE_TICKS,
    requestSpacingMs: env.PULSEHFT_RECOMMENDATION_REQUEST_SPACING_MS,
    maximumDailyRisePercent: env.PULSEHFT_RECOMMENDATION_MAX_DAILY_RISE_PERCENT,
    maximumVwapExtensionBps: env.PULSEHFT_RECOMMENDATION_MAX_VWAP_EXTENSION_BPS,
    maximumRecentRiseBps: env.PULSEHFT_RECOMMENDATION_MAX_RECENT_RISE_BPS,
    upperLimitProximityBps: env.PULSEHFT_RECOMMENDATION_UPPER_LIMIT_PROXIMITY_BPS,
    minimumExecutionStrength: env.PULSEHFT_RECOMMENDATION_MIN_EXECUTION_STRENGTH,
  });
}

export function normalizeRecommendationSettings(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RecommendationSettingsError("매수추천 설정은 객체여야 합니다.");
  }
  const merged = {
    ...DEFAULT_RECOMMENDATION_SETTINGS,
    ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== "")),
  };
  const normalized = {
    schemaVersion: 1,
    cacheTtlMs: integerInRange(merged.cacheTtlMs, 5_000, 300_000, "추천 캐시 시간"),
    maxUniverse: integerInRange(merged.maxUniverse, 10, 100, "1차 후보 수"),
    maxEnriched: integerInRange(merged.maxEnriched, 3, 20, "정밀 분석 후보 수"),
    minimumTradingValue: numberInRange(
      merged.minimumTradingValue,
      0,
      10_000_000_000_000,
      "최소 거래대금",
    ),
    targetNetProfitBps: numberInRange(merged.targetNetProfitBps, 1, 10_000, "목표 순수익률"),
    buyCommissionBps: numberInRange(merged.buyCommissionBps, 0, 500, "매수 수수료"),
    sellCommissionBps: numberInRange(merged.sellCommissionBps, 0, 500, "매도 수수료"),
    sellTaxBps: numberInRange(merged.sellTaxBps, 0, 500, "매도 세금"),
    expectedSlippageTicks: integerInRange(merged.expectedSlippageTicks, 0, 20, "예상 슬리피지"),
    requestSpacingMs: integerInRange(merged.requestSpacingMs, 0, 5_000, "KIS 요청 간격"),
    maximumDailyRisePercent: numberInRange(merged.maximumDailyRisePercent, 1, 30, "당일 상승률 차단 기준"),
    maximumVwapExtensionBps: numberInRange(merged.maximumVwapExtensionBps, 50, 3_000, "VWAP 상단 이격 차단 기준"),
    maximumRecentRiseBps: numberInRange(merged.maximumRecentRiseBps, 20, 2_000, "최근 급등 차단 기준"),
    upperLimitProximityBps: numberInRange(merged.upperLimitProximityBps, 10, 3_000, "상한가 근접 차단 기준"),
    minimumExecutionStrength: numberInRange(merged.minimumExecutionStrength, 0, 500, "체결강도 문턱"),
  };
  if (normalized.maxEnriched > normalized.maxUniverse) {
    throw new RecommendationSettingsError("정밀 분석 후보 수는 1차 후보 수보다 클 수 없습니다.");
  }
  return Object.freeze(normalized);
}

export function publicRecommendationSettings(settings) {
  const normalized = normalizeRecommendationSettings(settings);
  return {
    ...normalized,
    costModel: {
      source: "CONFIGURED_ESTIMATE",
      targetNetProfitPercent: normalized.targetNetProfitBps / 100,
      buyCommissionPercent: normalized.buyCommissionBps / 100,
      sellCommissionPercent: normalized.sellCommissionBps / 100,
      sellTaxPercent: normalized.sellTaxBps / 100,
      expectedSlippageTicks: normalized.expectedSlippageTicks,
      warning: "실제 계좌의 적용 수수료와 체결 후 정산금액으로 반드시 대사해야 합니다.",
    },
  };
}

function integerInRange(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new RecommendationSettingsError(`${label}는 ${minimum} 이상 ${maximum} 이하의 정수여야 합니다.`);
  }
  return number;
}

function numberInRange(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new RecommendationSettingsError(`${label}는 ${minimum} 이상 ${maximum} 이하의 숫자여야 합니다.`);
  }
  return number;
}
