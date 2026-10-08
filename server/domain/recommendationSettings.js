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
  // 정밀 분석(18개)에 앞서 1분봉만으로 눌림 후 재상승 모양을 선별하는 후보 수. 순위 점수만으로
  // 상위 18개를 고르면 순위 밖에 있는 눌림 후 재상승 종목은 영원히 못 본다(2026-10-07).
  // maxEnriched 이하이면 선별 없이 예전처럼 순위 상위를 쓴다.
  maxScreened: 50,
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
  // 실시간 확인 단계(realtimeConfirmationEngine.js)의 추격 제한 — 현재가가 VWAP보다
  // 이 이상 높으면 하드블록한다. 150은 REST 단계 가드(maximumVwapExtensionBps=500)
  // 보다 훨씬 타이트해서, 정상적으로 강하게 오르는 추세 종목(장중 VWAP 대비 1.5~3%
  // 벌어지는 건 흔함)이 REST는 통과하고도 실시간 단계에서 걸렸다(2026-10-01, "상승
  // 추세 종목을 못 찾는다"는 지적으로 확인). REST 가드보다는 여전히 타이트하게
  // 300으로 완화한다 — 진짜 과열 추격까지 열어주진 않는다.
  maximumRealtimeChaseBps: 300,
  // 고가 근처 모멘텀 신호(2026-10-07 측정으로 채택): 당일 고가에서 이 bp 이내이고 당일 등락률이
  // 이 범위일 때만 진입 확인 단계(75점)에 오른다. 기존 눌림목·반전·추세 점수는 같은 기간
  // 신호 단위로 재보니(신호 155건) 어느 보유시간에서도 무작위 진입보다 나빴다 — 검증 전까지
  // enableLegacyEntrySignals=false로 75점 미만에 묶는다.
  highMomentumMaxNearHighBps: 150,
  highMomentumMinChangePercent: 2.5,
  highMomentumMaxChangePercent: 8.7,
  enableLegacyEntrySignals: false,
  // 신규상장/공모주 당일 종목은 상장 초반 상승폭이 표준 변동성 가드(당일 상승률,
  // 상한가 근접)를 거의 항상 넘는다. 이 종목에 한해 가드를 완화해 스캐너가
  // 걸러내지 않도록 한다(2026-09-24, 사용자 요청).
  newlyListedWindowDays: 20,
  newlyListedMaximumDailyRisePercent: 30,
  newlyListedUpperLimitProximityBps: 50,
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
    maxScreened: env.PULSEHFT_RECOMMENDATION_MAX_SCREENED,
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
    maximumRealtimeChaseBps: env.PULSEHFT_RECOMMENDATION_MAX_REALTIME_CHASE_BPS,
    highMomentumMaxNearHighBps: env.PULSEHFT_RECOMMENDATION_HIGH_MOMENTUM_MAX_NEAR_HIGH_BPS,
    highMomentumMinChangePercent: env.PULSEHFT_RECOMMENDATION_HIGH_MOMENTUM_MIN_CHANGE_PERCENT,
    highMomentumMaxChangePercent: env.PULSEHFT_RECOMMENDATION_HIGH_MOMENTUM_MAX_CHANGE_PERCENT,
    enableLegacyEntrySignals: env.PULSEHFT_RECOMMENDATION_ENABLE_LEGACY_ENTRY_SIGNALS,
    newlyListedWindowDays: env.PULSEHFT_RECOMMENDATION_NEWLY_LISTED_WINDOW_DAYS,
    newlyListedMaximumDailyRisePercent:
      env.PULSEHFT_RECOMMENDATION_NEWLY_LISTED_MAX_DAILY_RISE_PERCENT,
    newlyListedUpperLimitProximityBps:
      env.PULSEHFT_RECOMMENDATION_NEWLY_LISTED_UPPER_LIMIT_PROXIMITY_BPS,
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
    maxScreened: integerInRange(merged.maxScreened, 0, 100, "모양 선별 후보 수"),
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
    maximumRealtimeChaseBps: numberInRange(merged.maximumRealtimeChaseBps, 0, 3_000, "실시간 추격 제한 기준"),
    highMomentumMaxNearHighBps: numberInRange(merged.highMomentumMaxNearHighBps, 0, 3_000, "고가 근처 기준"),
    highMomentumMinChangePercent: numberInRange(merged.highMomentumMinChangePercent, -30, 30, "고가 근처 신호 최소 등락률"),
    highMomentumMaxChangePercent: numberInRange(merged.highMomentumMaxChangePercent, -30, 30, "고가 근처 신호 최대 등락률"),
    enableLegacyEntrySignals: booleanValue(merged.enableLegacyEntrySignals),
    newlyListedWindowDays: integerInRange(merged.newlyListedWindowDays, 0, 60, "신규상장 인정 기간"),
    newlyListedMaximumDailyRisePercent: numberInRange(
      merged.newlyListedMaximumDailyRisePercent,
      1,
      30,
      "신규상장 당일 상승률 차단 기준",
    ),
    newlyListedUpperLimitProximityBps: numberInRange(
      merged.newlyListedUpperLimitProximityBps,
      10,
      3_000,
      "신규상장 상한가 근접 차단 기준",
    ),
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

function booleanValue(value) {
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(text)) return true;
  if (["false", "0", "no", "off"].includes(text)) return false;
  throw new RecommendationSettingsError("legacy 신호 사용 여부는 true 또는 false여야 합니다.");
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
