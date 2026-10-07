import { normalizeRecommendationSettings } from "./recommendationSettings.js";

// 최근 4개 분봉 수익률이 이 값 이상이어야 "다시 오르기 시작했다"고 본다. 점수 가산
// 기준이면서 진입 확인 단계(75점) 진입의 필수 조건이다.
const MIN_RECENT_RISE_BPS = 8;

// 1분봉 스윙(눌림→재상승) 판정 기준. 눌림이 이 폭 이상이어야 "눌림"으로 보고,
// 바닥에서 이만큼 올라와야 "재상승"으로 인정한다.
const MIN_PULLBACK_DEPTH_BPS = 15;
const MIN_RERISE_FROM_TROUGH_BPS = 15;
const MIN_BARS_SINCE_TROUGH = 2;
// 15분봉 흐름: 이 개수 이상의 봉이 있어야 추세를 판단한다. 3개로 두면 09:30에야 열려서
// 9시부터 오르는 종목을 09:10~09:30에 못 잡는다(2026-10-07, 장 초반이 이 시스템에서 가장
// 덜 나빴던 시간대라 열어둔다). 봉이 2개뿐인 구간도 상승 다리(+30bp)·눌림·구조 조건은
// 그대로 적용한다. 09:00~09:10은 별도 진입 금지 시간대(noEntryWindows)가 막는다.
const MIN_FLOW_BARS = 2;
const FLOW_LOW_TOLERANCE_BPS = 10;
// 15분봉 상승 다리(처음 봉 종가 → 최고 종가)가 이 이상이어야 "상승 흐름"으로 본다.
const MIN_FLOW_UP_LEG_BPS = 30;
// 15분봉 눌림폭(최고 종가 대비 현재가) 범위. 미만이면 신고점 근처, 초과면 구조가 깨진 것으로 본다.
const MIN_FLOW_PULLBACK_BPS = 20;
const MAX_FLOW_PULLBACK_BPS = 300;
// 1분봉 재상승: 바닥(최근 14분봉 최저 종가)이 이 분봉 수 안에 있어야 "방금 올라오는" 것으로 본다.
const MAX_BARS_SINCE_BOUNCE_TROUGH = 10;

export function evaluateRecommendationCandidate(input, settingsInput = {}) {
  const settings = normalizeRecommendationSettings(settingsInput);
  const candidate = normalizeCandidate(input);
  const bars = normalizeBars(candidate.minuteBars);
  const barSupply = describeBarSupply(candidate.minuteBars, bars);
  const orderBook = normalizeOrderBook(candidate.orderBook, candidate.tickSize);
  const flowBars = normalizeBars(candidate.flowBars);
  const derived = calculateDerived(candidate, bars, orderBook, flowBars);
  const blockReasons = buildBlockReasons(candidate, bars, orderBook, derived, settings, barSupply);
  const reversal = scoreReversal(candidate, derived, orderBook);
  const pullback = scorePullback(candidate, derived, orderBook);
  const momentum = scoreMomentum(candidate, derived, orderBook);
  // 기존 pullback≥reversal 동점 우선순위는 그대로 두고, momentum은 분명히
  // 더 높을 때만(동점이면 안 바꿈) 끼어든다 — 기존 두 경로의 동점 처리에
  // 영향을 주지 않기 위해서다.
  let selected = pullback.score >= reversal.score ? pullback : reversal;
  if (momentum.score > selected.score) selected = momentum;
  // 다시 오르기 시작했다는 확인(최근 분봉 수익률 ≥ MIN_RECENT_RISE_BPS) 없이는
  // 진입 확인 단계(75점)에 못 올라가게 점수를 74점에 묶는다. 재상승 항목은 점수
  // 가산점일 뿐이라 나머지 항목만으로 84점까지 나왔고, 그 결과 눌리는 도중에
  // 진입했다(2026-10-06 파미셀: 최근 4분봉 -110bp 하락 중 매수 → 반등 없이 2분 만에
  // 손절). 사용자의 원래 계획은 "재상승 확인 후 매수"다.
  // 흐름과 눌림은 15분봉, 재상승 타이밍은 1분봉으로 본다(2026-10-07). 15분봉이 주어지면
  // (shape.source === "FLOW15") 눌림 여부·폭을 15분봉으로 판단하고, 1분봉은 바닥에서
  // 다시 올라오는지(bounceRising)만 본다. 15분봉이 없으면 1분봉 스윙으로 대신한다.
  // 눌림이 있으면 재상승(shape.rising)이어야 하고, 눌림이 없으면 최근 분봉이 오르는 중이어야 한다.
  const shape = derived.shape;
  const timingConfirmed = shape.dip
    ? shape.rising
    : derived.recentReturnBps >= MIN_RECENT_RISE_BPS;
  const flowGateActive = Array.isArray(candidate.flowBars);
  const flowKnown = derived.flowBarCount >= MIN_FLOW_BARS;
  let flowConfirmed = true;
  let flowWaitReason = null;
  if (flowGateActive) {
    if (!flowKnown) {
      flowConfirmed = false;
      flowWaitReason = "15분 흐름 확인 불가 — 진입 대기";
    } else if (selected.type === "PULLBACK") {
      flowConfirmed = derived.flowState === "UPTREND_PULLBACK";
      flowWaitReason = "15분봉 상승 흐름 속 눌림 아님 — 진입 대기";
    } else {
      flowConfirmed = derived.flowState === "UPTREND_PULLBACK" || derived.flowState === "UPTREND_AT_HIGH";
      flowWaitReason = "15분 상승 흐름 아님 — 진입 대기";
    }
  }
  const risingConfirmed = timingConfirmed && flowConfirmed;
  const waitingReasons = [];
  if (!timingConfirmed) waitingReasons.push("재상승 확인 전 — 진입 대기");
  if (!flowConfirmed) waitingReasons.push(flowWaitReason);
  const reasons = risingConfirmed ? selected.reasons : [...waitingReasons, ...selected.reasons];
  const cappedScore = risingConfirmed ? selected.score : Math.min(selected.score, 74);
  const score = blockReasons.length > 0 ? Math.min(cappedScore, 49) : cappedScore;
  const stage = blockReasons.length > 0
    ? "BLOCKED"
    : score >= 75
      ? "CONFIRMATION_REQUIRED"
      : score >= 55
        ? "WATCH"
        : "LOW_PRIORITY";
  const target = estimateTarget(candidate.currentPrice, orderBook.tickSize, settings);

  return {
    symbol: candidate.symbol,
    name: candidate.name,
    market: candidate.market,
    isNewlyListed: candidate.isNewlyListed,
    daysSinceListing: candidate.daysSinceListing,
    listingDate: candidate.listingDate,
    candidateType: selected.type,
    stage,
    score,
    currentPrice: candidate.currentPrice,
    changePercent: candidate.changePercent,
    accumulatedVolume: candidate.accumulatedVolume,
    accumulatedTradingValue: candidate.accumulatedTradingValue,
    executionStrength: candidate.executionStrength,
    volumeRank: candidate.volumeRank,
    fluctuationRank: candidate.fluctuationRank,
    volumePowerRank: candidate.volumePowerRank,
    price: {
      open: candidate.openPrice,
      high: candidate.highPrice,
      low: candidate.lowPrice,
      previousClose: candidate.previousClose,
      upperLimit: candidate.upperLimitPrice,
      vwap: derived.vwap,
      recentHigh: derived.recentHigh,
      recentLow: derived.recentLow,
    },
    microstructure: {
      bestBid: orderBook.bestBid,
      bestAsk: orderBook.bestAsk,
      spread: orderBook.spread,
      spreadTicks: orderBook.spreadTicks,
      bidAskImbalance: derived.bookImbalance,
      minuteBars: bars.length,
      priorReturnBps: derived.priorReturnBps,
      recentReturnBps: derived.recentReturnBps,
      reboundFromLowBps: derived.reboundFromLowBps,
      pullbackDepthBps: derived.pullbackDepthBps,
      volumeContractionRatio: derived.volumeContractionRatio,
      higherRecentLows: derived.higherRecentLows,
      vwapExtensionBps: derived.vwapExtensionBps,
      upperLimitDistanceBps: derived.upperLimitDistanceBps,
    },
    reasons: reasons.slice(0, 6),
    blockReasons,
    pullbackRerise: {
      confirmed: risingConfirmed && shape.dip,
      source: shape.source,
      flowState: derived.flowState,
      flowUptrend: derived.flowUptrend,
      flowBars: derived.flowBarCount,
      // 눌림폭: 15분봉이 있으면 15분 눌림(최고 종가 대비), 없으면 1분봉 스윙 낙폭.
      swingDepthBps: shape.depthBps,
      // 1분봉 바닥 대비 현재가 상승폭.
      reRiseFromTroughBps: shape.source === "FLOW15" ? derived.bounceFromTroughBps : derived.reRiseFromTroughBps,
      barsSinceTrough: shape.source === "FLOW15" ? derived.bounceBarsSinceTrough : derived.barsSinceTrough,
    },
    target,
    confirmation: {
      required: true,
      reason: "REST 스냅샷 기반 1차 후보입니다. 실시간 체결·호가 WebSocket 전환 확인 전 자동매수하면 안 됩니다.",
    },
    dataCompleteness: calculateCompleteness(candidate, bars, orderBook),
    fetchedAt: candidate.fetchedAt,
  };
}

export function estimateTarget(currentPrice, tickSize, settingsInput = {}) {
  const settings = normalizeRecommendationSettings(settingsInput);
  const price = positiveOrNull(currentPrice);
  const tick = positiveOrNull(tickSize) ?? 1;
  if (price === null) {
    return {
      targetNetProfitBps: settings.targetNetProfitBps,
      breakEvenPrice: null,
      targetPrice: null,
      estimatedRoundTripCostBps: null,
    };
  }
  const buyRate = settings.buyCommissionBps / 10_000;
  const sellRate = (settings.sellCommissionBps + settings.sellTaxBps) / 10_000;
  const targetNetRate = settings.targetNetProfitBps / 10_000;
  const slippageAmount = settings.expectedSlippageTicks * tick;

  const totalBuyCost = price * (1 + buyRate);
  const rawBreakEven = totalBuyCost / Math.max(1e-9, 1 - sellRate) + slippageAmount;
  const rawTarget = (totalBuyCost * (1 + targetNetRate)) / Math.max(1e-9, 1 - sellRate) + slippageAmount;
  const breakEvenPrice = roundUpToTick(rawBreakEven, tick);
  const targetPrice = roundUpToTick(rawTarget, tick);
  const estimatedRoundTripCostBps = ((breakEvenPrice - price) / price) * 10_000;
  return {
    targetNetProfitBps: settings.targetNetProfitBps,
    targetNetProfitPercent: settings.targetNetProfitBps / 100,
    breakEvenPrice,
    targetPrice,
    expectedSlippageTicks: settings.expectedSlippageTicks,
    estimatedRoundTripCostBps: round(estimatedRoundTripCostBps, 3),
    model: "CONFIGURED_ESTIMATE",
  };
}

function scoreReversal(candidate, derived, orderBook) {
  let score = 0;
  const reasons = [];
  if (derived.priorReturnBps <= -20) score += add(14, "직전 구간 하락 후 반전 감시", reasons);
  if (derived.recentReturnBps >= MIN_RECENT_RISE_BPS) score += add(16, "최근 가격 기울기가 상승으로 전환", reasons);
  if (derived.reboundFromLowBps >= 20 && derived.reboundFromLowBps <= 250) {
    score += add(14, "최근 저점에서 유효한 반등", reasons);
  }
  if (derived.higherRecentLows) score += add(12, "최근 저점이 더 이상 낮아지지 않음", reasons);
  if (derived.bookImbalance >= 0.08) score += add(14, "매수호가 잔량 우위", reasons);
  if (candidate.executionStrength !== null && candidate.executionStrength >= 100) {
    score += add(12, "체결강도 100 이상", reasons);
  }
  if (orderBook.spreadTicks !== null && orderBook.spreadTicks <= 2) score += add(8, "스프레드 2틱 이하", reasons);
  if (candidate.accumulatedTradingValue >= 5_000_000_000) score += add(6, "거래대금 충분", reasons);
  if (candidate.changePercent !== null && candidate.changePercent < 0) score += add(4, "당일 약세 구간의 반전 후보", reasons);
  return { type: "REVERSAL", score: Math.min(100, score), reasons };
}

function scorePullback(candidate, derived, orderBook) {
  let score = 0;
  const reasons = [];
  if (candidate.changePercent !== null && candidate.changePercent > 0) score += add(10, "당일 상승 추세 유지", reasons);
  const shape = derived.shape;
  if (shape.upLegBps >= 20 || derived.priorReturnBps >= 20) {
    score += add(16, "눌림 전 상승 모멘텀 확인", reasons);
  }
  if (derived.vwap !== null && candidate.currentPrice > derived.vwap) score += add(14, "현재가가 단기 VWAP 위", reasons);
  if (shape.dip && shape.depthBps <= MAX_FLOW_PULLBACK_BPS) {
    score += add(14, shape.source === "FLOW15" ? "15분봉 상승 흐름 속 과도하지 않은 눌림" : "과도하지 않은 짧은 눌림", reasons);
  }
  if (shape.rising) score += add(16, "눌림 후 재상승", reasons);
  if (derived.volumeContractionRatio !== null && derived.volumeContractionRatio <= 0.9) {
    score += add(10, "눌림 구간 거래량 감소", reasons);
  }
  if (derived.bookImbalance >= 0.05) score += add(10, "재상승 시 매수호가 우위", reasons);
  if (orderBook.spreadTicks !== null && orderBook.spreadTicks <= 2) score += add(6, "스프레드 2틱 이하", reasons);
  if (candidate.accumulatedTradingValue >= 5_000_000_000) score += add(4, "거래대금 충분", reasons);
  return { type: "PULLBACK", score: Math.min(100, score), reasons };
}

// 눌림목(scorePullback)·반전(scoreReversal)은 둘 다 "한 번 빠졌다가 다시
// 오른다"는 모양에 가산점을 준다. 문제는 pullbackDepthBps(최근 4분봉 고점
// 대비 눌림폭)가 "눌렸다가 이미 회복된" 종목도 "한 번도 안 눌린" 종목도 똑같이
// 0에 가깝게 나온다는 점이다 — 둘 다 마지막 분봉이 곧 최근 고점이기 때문에,
// 이 지표 하나로는 구분이 안 된다. 실제로 구분되는 신호는 거래량이다: 눌림목은
// 눌리는 구간에서 거래량이 줄어야 신뢰도가 높고(volumeContractionRatio≤0.9),
// 쉬지 않고 오르는 진짜 추세는 거래량이 줄지 않고 유지·증가한다(2026-10-01,
// "상승추세 종목을 빨리 찾아야 하는데 못 찾는 것 같다"는 지적으로 확인·보정
// — 처음엔 pullbackDepthBps만으로 구분하려다 기존 PULLBACK 테스트 후보까지
// MOMENTUM으로 잘못 뺏는 회귀를 테스트로 잡아 거래량 기준으로 바꿨다).
function scoreMomentum(candidate, derived, orderBook) {
  let score = 0;
  const reasons = [];
  if (candidate.changePercent !== null && candidate.changePercent > 0) score += add(8, "당일 상승 추세 유지", reasons);
  if (derived.priorReturnBps >= 20) score += add(16, "직전 구간부터 이어지는 상승", reasons);
  if (derived.recentReturnBps >= MIN_RECENT_RISE_BPS) score += add(16, "최근에도 계속 상승", reasons);
  if (derived.higherRecentLows) score += add(14, "저점이 계속 높아지는 추세", reasons);
  if (derived.volumeContractionRatio !== null && derived.volumeContractionRatio >= 1) {
    score += add(16, "거래량이 줄지 않고 유지·증가하며 상승", reasons);
  }
  if (derived.bookImbalance >= 0.05) score += add(10, "매수호가 우위", reasons);
  if (orderBook.spreadTicks !== null && orderBook.spreadTicks <= 2) score += add(6, "스프레드 2틱 이하", reasons);
  if (candidate.accumulatedTradingValue >= 5_000_000_000) score += add(4, "거래대금 충분", reasons);
  return { type: "MOMENTUM", score: Math.min(100, score), reasons };
}

// 데이터 공급 결함과 전략 판정을 구분한다. 응답이 통째로 비어 있는 것과
// 분봉이 실제로 모자란 것은 원인도 대응도 다르다.
function describeBarSupply(rawValue, bars) {
  const rawCount = Array.isArray(rawValue) ? rawValue.length : 0;
  return {
    rawCount,
    usableCount: bars.length,
    emptyResponse: rawCount > 0 && bars.length === 0,
  };
}

function buildBlockReasons(candidate, bars, orderBook, derived, settings, barSupply) {
  const reasons = [];
  if (candidate.tradingHalted) reasons.push("거래정지 또는 일시정지 상태");
  if (candidate.currentPrice === null) reasons.push("현재가 없음");
  if (candidate.accumulatedTradingValue < settings.minimumTradingValue) {
    reasons.push(`누적 거래대금 ${formatWon(settings.minimumTradingValue)} 미만`);
  }
  if (barSupply.emptyResponse) {
    reasons.push(`분봉 응답 ${barSupply.rawCount}건이 모두 빈 값 — 시세 데이터 결함`);
  } else if (bars.length < 8) {
    reasons.push("당일 분봉 데이터 8개 미만");
  }
  // REST 체결강도 결측은 차단 사유가 아니다. ENTRY_READY의 체결강도 게이트는
  // 실시간 체결(H0STCNT0)이 판정하며 그쪽은 종목 전량 수신된다
  // (realtimeConfirmationEngine.js). REST 값은 예비 점수에만 쓰이므로,
  // 없으면 powerScore가 0이 될 뿐이고 결측 자체는 dataCompleteness로 드러난다.
  if (orderBook.bestBid === null || orderBook.bestAsk === null) reasons.push("최우선 호가 없음");
  if (orderBook.spreadTicks !== null && orderBook.spreadTicks > 3) reasons.push("스프레드 3틱 초과");
  // 신규상장/공모주 당일 종목은 상장 초반 상승폭이 표준 가드를 거의 항상 넘는다.
  // 이 두 가드만 완화된 문턱을 쓴다(사용자 승인, 2026-09-24). VWAP 이격·최근
  // 급등 가드는 신규상장 여부와 무관하게 그대로 적용한다 — 장중 과열 추격은
  // 여전히 걸러야 한다.
  const dailyRiseCap = candidate.isNewlyListed
    ? settings.newlyListedMaximumDailyRisePercent
    : settings.maximumDailyRisePercent;
  if (candidate.changePercent !== null && candidate.changePercent > dailyRiseCap) {
    reasons.push(`당일 상승률 ${dailyRiseCap}% 초과`);
  }
  if (derived.vwapExtensionBps !== null && derived.vwapExtensionBps > settings.maximumVwapExtensionBps) {
    reasons.push(`VWAP 상단 이격 ${settings.maximumVwapExtensionBps}bp 초과`);
  }
  if (derived.recentReturnBps > settings.maximumRecentRiseBps) {
    reasons.push(`최근 4개 분봉 상승 ${settings.maximumRecentRiseBps}bp 초과`);
  }
  const upperLimitCap = candidate.isNewlyListed
    ? settings.newlyListedUpperLimitProximityBps
    : settings.upperLimitProximityBps;
  if (derived.upperLimitDistanceBps !== null && derived.upperLimitDistanceBps <= upperLimitCap) {
    reasons.push(`상한가 ${upperLimitCap}bp 이내 근접`);
  }
  if (candidate.fetchedAt !== null && candidate.evaluatedAt - candidate.fetchedAt > 60_000) {
    reasons.push("시세 데이터 60초 초과 지연");
  }
  return reasons;
}

// 최근 최대 14개 1분봉 종가에서 "달리는 최고 종가 대비 최대 낙폭" 지점을 눌림 바닥으로
// 잡는다. 현재가를 최근 4분봉 고점과 비교하던 pullbackDepthBps는 눌린 뒤 재상승이
// 진행될수록 0에 가까워져 눌림목으로 안 보였다(2026-10-07).
function analyzeSwing(bars, currentPrice) {
  const window = bars.slice(-14);
  const empty = {
    swingDepthBps: 0, preSwingRiseBps: 0, reRiseFromTroughBps: 0, barsSinceTrough: 0, reRising: false,
  };
  if (window.length < 6) return empty;
  let runningMax = -Infinity;
  let runningMaxIndex = -1;
  let best = null;
  window.forEach((bar, index) => {
    if (bar.close > runningMax) {
      runningMax = bar.close;
      runningMaxIndex = index;
    }
    const drawdown = ((runningMax - bar.close) / runningMax) * 10_000;
    if (drawdown > (best?.drawdown ?? 0)) {
      best = { drawdown, peak: runningMax, peakIndex: runningMaxIndex, trough: bar.close, troughIndex: index };
    }
  });
  if (!best) return empty;
  const price = currentPrice ?? window.at(-1).close;
  const barsSinceTrough = window.length - 1 - best.troughIndex;
  const reRiseFromTroughBps = returnBps(best.trough, price);
  const lastBarUp = window.length >= 2 && window.at(-1).close >= window.at(-2).close;
  return {
    swingDepthBps: round(best.drawdown, 2),
    preSwingRiseBps: round(returnBps(window[0].close, best.peak), 2),
    reRiseFromTroughBps: round(reRiseFromTroughBps, 2),
    barsSinceTrough,
    reRising: best.drawdown >= MIN_PULLBACK_DEPTH_BPS
      && barsSinceTrough >= MIN_BARS_SINCE_TROUGH
      && reRiseFromTroughBps >= MIN_RERISE_FROM_TROUGH_BPS
      && lastBarUp,
  };
}

// 15분봉 흐름과 눌림(2026-10-07): 최근 최대 8개 봉에서 최고가(고가) 봉(peak)을 찾는다.
// 종가가 아니라 고가를 쓰는 이유: 진행 중인 마지막 봉의 종가는 곧 현재가라서, 같은 봉 안에서
// 올랐다가 빠진 눌림(예: 09:15~09:30 봉 안의 눌림)이 종가로는 안 보인다.
// peak까지가 상승 다리(처음 종가 대비 +30bp 이상, 저점이 허용 오차 안에서 높아짐)이고,
// peak 대비 현재가 낙폭이 20~300bp이며 눌림 저점이 상승 다리 최저 저점 아래로 안 내려갔으면
// "상승 흐름 속 눌림"(UPTREND_PULLBACK). 낙폭이 20bp 미만이면 신고점 근처(UPTREND_AT_HIGH).
function analyzeFlow(flowBars, currentPrice) {
  const window = flowBars.slice(-8);
  const base = {
    flowBarCount: window.length, flowState: "UNKNOWN", flowUptrend: false, flowPullbackBps: 0, flowUpLegBps: 0,
  };
  if (window.length < MIN_FLOW_BARS) return base;
  let peakIndex = 0;
  window.forEach((bar, index) => {
    if (bar.high > window[peakIndex].high) peakIndex = index;
  });
  const price = currentPrice ?? window.at(-1).close;
  const peakClose = Math.max(window[peakIndex].high, price);
  const upLeg = window.slice(0, peakIndex + 1);
  const upLegBps = returnBps(upLeg[0].close, window[peakIndex].high);
  const higherLows = upLeg.slice(1).every((bar, index) => (
    returnBps(upLeg[index].low, bar.low) >= -FLOW_LOW_TOLERANCE_BPS
  ));
  const pullbackBps = Math.max(0, ((peakClose - price) / peakClose) * 10_000);
  const upLegMinLow = Math.min(...upLeg.map((bar) => bar.low));
  const afterPeak = window.slice(peakIndex + 1);
  const pullbackLow = afterPeak.length > 0
    ? Math.min(price, ...afterPeak.map((bar) => bar.low))
    : price;
  const structureIntact = pullbackLow >= upLegMinLow * (1 - FLOW_LOW_TOLERANCE_BPS / 10_000);
  const upLegOk = peakIndex >= 1 && upLegBps >= MIN_FLOW_UP_LEG_BPS && higherLows;
  let flowState = "NOT_UPTREND";
  if (upLegOk && pullbackBps < MIN_FLOW_PULLBACK_BPS) flowState = "UPTREND_AT_HIGH";
  else if (upLegOk && pullbackBps <= MAX_FLOW_PULLBACK_BPS && structureIntact) flowState = "UPTREND_PULLBACK";
  return {
    flowBarCount: window.length,
    flowState,
    flowUptrend: flowState === "UPTREND_AT_HIGH" || flowState === "UPTREND_PULLBACK",
    flowPullbackBps: round(pullbackBps, 2),
    flowUpLegBps: round(upLegBps, 2),
  };
}

// 1분봉은 재상승 타이밍만 본다: 최근 14개 종가의 최고점 이후 바닥에서 다시 올라오는 중인가.
// 최고점이 지금(마지막 분봉)이면 눌림 없이 신고점이므로 최근 4분봉이 오르는 중인지만 본다.
function analyzeBounce(bars, currentPrice) {
  const window = bars.slice(-14);
  const empty = { bounceRising: false, bounceFromTroughBps: 0, bounceBarsSinceTrough: 0 };
  if (window.length < 6) return empty;
  let peakIndex = 0;
  window.forEach((bar, index) => {
    if (bar.close >= window[peakIndex].close) peakIndex = index;
  });
  const price = currentPrice ?? window.at(-1).close;
  const lastBarUp = window.at(-1).close >= window.at(-2).close;
  if (peakIndex === window.length - 1) {
    const recentBps = returnBps(window.at(-4).close, window.at(-1).close);
    return {
      bounceRising: lastBarUp && recentBps >= MIN_RECENT_RISE_BPS,
      bounceFromTroughBps: round(recentBps, 2),
      bounceBarsSinceTrough: 0,
    };
  }
  let troughIndex = peakIndex + 1;
  window.forEach((bar, index) => {
    if (index > peakIndex && bar.close <= window[troughIndex].close) troughIndex = index;
  });
  const barsSinceTrough = window.length - 1 - troughIndex;
  const bounceFromTroughBps = returnBps(window[troughIndex].close, price);
  return {
    bounceRising: barsSinceTrough >= MIN_BARS_SINCE_TROUGH
      && barsSinceTrough <= MAX_BARS_SINCE_BOUNCE_TROUGH
      && bounceFromTroughBps >= MIN_RERISE_FROM_TROUGH_BPS
      && lastBarUp,
    bounceFromTroughBps: round(bounceFromTroughBps, 2),
    bounceBarsSinceTrough: barsSinceTrough,
  };
}

// 눌림 모양의 출처를 고른다: 15분봉이 있으면 눌림은 15분봉, 재상승은 1분봉 바닥 반등.
// 15분봉이 없으면(조회 전·미지원) 예전처럼 1분봉 스윙으로 대신한다.
function pickPullbackShape(swing, flow, bounce) {
  if (flow.flowBarCount >= MIN_FLOW_BARS) {
    return {
      source: "FLOW15",
      dip: flow.flowState === "UPTREND_PULLBACK",
      depthBps: flow.flowPullbackBps,
      upLegBps: flow.flowUpLegBps,
      rising: bounce.bounceRising,
    };
  }
  return {
    source: "MIN1",
    dip: swing.swingDepthBps >= MIN_PULLBACK_DEPTH_BPS,
    depthBps: swing.swingDepthBps,
    upLegBps: swing.preSwingRiseBps,
    rising: swing.reRising,
  };
}

function calculateDerived(candidate, bars, orderBook, flowBars = []) {
  const closes = bars.map((bar) => bar.close).filter(Number.isFinite);
  const recent = bars.slice(-4);
  const prior = bars.slice(Math.max(0, bars.length - 14), Math.max(0, bars.length - 4));
  const recentReturnBps = returnBps(recent[0]?.close, recent.at(-1)?.close);
  const priorReturnBps = returnBps(prior[0]?.close, prior.at(-1)?.close);
  const recentHigh = recent.length > 0 ? Math.max(...recent.map((bar) => bar.high)) : null;
  const recentLow = recent.length > 0 ? Math.min(...recent.map((bar) => bar.low)) : null;
  const reboundFromLowBps = returnBps(recentLow, candidate.currentPrice);
  const pullbackDepthBps = recentHigh && candidate.currentPrice
    ? ((recentHigh - candidate.currentPrice) / recentHigh) * 10_000
    : 0;
  const previousVolumes = bars.slice(Math.max(0, bars.length - 9), Math.max(0, bars.length - 4)).map((bar) => bar.volume);
  const recentVolumes = recent.map((bar) => bar.volume);
  const previousAverageVolume = average(previousVolumes);
  const recentAverageVolume = average(recentVolumes);
  const volumeContractionRatio = previousAverageVolume > 0 ? recentAverageVolume / previousAverageVolume : null;
  const vwapDenominator = bars.reduce((sum, bar) => sum + bar.volume, 0);
  const vwap = vwapDenominator > 0
    ? bars.reduce((sum, bar) => sum + bar.close * bar.volume, 0) / vwapDenominator
    : average(closes);
  const recentLows = recent.map((bar) => bar.low);
  const vwapExtensionBps = vwap && candidate.currentPrice
    ? returnBps(vwap, candidate.currentPrice)
    : null;
  const upperLimitDistanceBps = candidate.upperLimitPrice && candidate.currentPrice
    ? ((candidate.upperLimitPrice - candidate.currentPrice) / candidate.upperLimitPrice) * 10_000
    : null;
  const higherRecentLows = recentLows.length >= 3
    && recentLows.slice(1).every((low, index) => low >= recentLows[index]);
  const totalBook = orderBook.totalBidSize + orderBook.totalAskSize;
  const bookImbalance = totalBook > 0
    ? (orderBook.totalBidSize - orderBook.totalAskSize) / totalBook
    : 0;
  const swing = analyzeSwing(bars, candidate.currentPrice);
  const flow = analyzeFlow(flowBars, candidate.currentPrice);
  const bounce = analyzeBounce(bars, candidate.currentPrice);
  return {
    vwap: finiteOrNull(vwap),
    recentHigh: finiteOrNull(recentHigh),
    recentLow: finiteOrNull(recentLow),
    recentReturnBps: round(recentReturnBps, 2),
    priorReturnBps: round(priorReturnBps, 2),
    reboundFromLowBps: round(reboundFromLowBps, 2),
    pullbackDepthBps: round(Math.max(0, pullbackDepthBps), 2),
    volumeContractionRatio: finiteOrNull(volumeContractionRatio),
    higherRecentLows,
    vwapExtensionBps: vwapExtensionBps === null ? null : round(vwapExtensionBps, 2),
    upperLimitDistanceBps: upperLimitDistanceBps === null ? null : round(upperLimitDistanceBps, 2),
    bookImbalance: round(bookImbalance, 4),
    ...swing,
    ...flow,
    ...bounce,
    shape: pickPullbackShape(swing, flow, bounce),
  };
}

function calculateCompleteness(candidate, bars, orderBook) {
  const checks = [
    candidate.currentPrice !== null,
    candidate.accumulatedTradingValue > 0,
    bars.length >= 8,
    orderBook.bestBid !== null,
    orderBook.bestAsk !== null,
    candidate.executionStrength !== null,
  ];
  const complete = checks.filter(Boolean).length;
  return {
    complete,
    total: checks.length,
    percent: Math.round((complete / checks.length) * 100),
  };
}

function normalizeCandidate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("추천 후보 입력은 객체여야 합니다.");
  }
  const symbol = String(input.symbol ?? "").trim().toUpperCase();
  if (!/^(?:\d{6}|Q\d{6})$/.test(symbol)) throw new TypeError("유효한 종목코드가 필요합니다.");
  return {
    symbol,
    name: String(input.name ?? symbol).trim() || symbol,
    market: String(input.market ?? "KRX").trim() || "KRX",
    currentPrice: positiveOrNull(input.currentPrice),
    previousClose: positiveOrNull(input.previousClose),
    openPrice: positiveOrNull(input.openPrice),
    highPrice: positiveOrNull(input.highPrice),
    lowPrice: positiveOrNull(input.lowPrice),
    upperLimitPrice: positiveOrNull(input.upperLimitPrice),
    changePercent: finiteOrNull(input.changePercent),
    accumulatedVolume: Math.max(0, finiteOrNull(input.accumulatedVolume) ?? 0),
    accumulatedTradingValue: Math.max(0, finiteOrNull(input.accumulatedTradingValue) ?? 0),
    executionStrength: finiteOrNull(input.executionStrength),
    volumeRank: integerOrNull(input.volumeRank),
    fluctuationRank: integerOrNull(input.fluctuationRank),
    volumePowerRank: integerOrNull(input.volumePowerRank),
    tradingHalted: Boolean(input.tradingHalted),
    isNewlyListed: Boolean(input.isNewlyListed),
    daysSinceListing: integerOrNull(input.daysSinceListing),
    listingDate: input.listingDate ? String(input.listingDate) : null,
    tickSize: positiveOrNull(input.tickSize) ?? 1,
    orderBook: input.orderBook,
    minuteBars: input.minuteBars,
    // 배열이면(비어 있어도) 15분 흐름 게이트를 적용하고, 아예 안 주면 적용하지 않는다.
    flowBars: Array.isArray(input.flowBars) ? input.flowBars : undefined,
    fetchedAt: finiteOrNull(input.fetchedAt),
    evaluatedAt: finiteOrNull(input.evaluatedAt) ?? Date.now(),
  };
}

function normalizeBars(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((bar, index) => ({
      time: String(bar?.time ?? index),
      open: positiveOrNull(bar?.open),
      high: positiveOrNull(bar?.high),
      low: positiveOrNull(bar?.low),
      close: positiveOrNull(bar?.close),
      volume: Math.max(0, finiteOrNull(bar?.volume) ?? 0),
    }))
    .filter((bar) => [bar.open, bar.high, bar.low, bar.close].every((item) => item !== null))
    .sort((a, b) => a.time.localeCompare(b.time));
}

function normalizeOrderBook(value, fallbackTickSize) {
  const tickSize = positiveOrNull(value?.tickSize) ?? positiveOrNull(fallbackTickSize) ?? 1;
  const bestBid = positiveOrNull(value?.bestBid);
  const bestAsk = positiveOrNull(value?.bestAsk);
  const spread = bestBid !== null && bestAsk !== null ? Math.max(0, bestAsk - bestBid) : null;
  return {
    bestBid,
    bestAsk,
    totalBidSize: Math.max(0, finiteOrNull(value?.totalBidSize) ?? 0),
    totalAskSize: Math.max(0, finiteOrNull(value?.totalAskSize) ?? 0),
    spread,
    spreadTicks: spread === null ? null : spread / tickSize,
    tickSize,
  };
}

function add(points, reason, reasons) {
  reasons.push(reason);
  return points;
}

function returnBps(start, end) {
  const first = positiveOrNull(start);
  const last = positiveOrNull(end);
  if (first === null || last === null) return 0;
  return ((last - first) / first) * 10_000;
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length > 0 ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0;
}

function roundUpToTick(value, tickSize) {
  return Math.ceil(value / tickSize) * tickSize;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(number) ? number : null;
}

function positiveOrNull(value) {
  const number = finiteOrNull(value);
  return number !== null && number > 0 ? number : null;
}

function integerOrNull(value) {
  const number = finiteOrNull(value);
  return number !== null && Number.isInteger(number) ? number : null;
}

function round(value, digits) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatWon(value) {
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}
