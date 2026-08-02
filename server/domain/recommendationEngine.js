import { normalizeRecommendationSettings } from "./recommendationSettings.js";

export function evaluateRecommendationCandidate(input, settingsInput = {}) {
  const settings = normalizeRecommendationSettings(settingsInput);
  const candidate = normalizeCandidate(input);
  const bars = normalizeBars(candidate.minuteBars);
  const orderBook = normalizeOrderBook(candidate.orderBook, candidate.tickSize);
  const derived = calculateDerived(candidate, bars, orderBook);
  const blockReasons = buildBlockReasons(candidate, bars, orderBook, derived, settings);
  const reversal = scoreReversal(candidate, derived, orderBook);
  const pullback = scorePullback(candidate, derived, orderBook);
  const selected = pullback.score >= reversal.score ? pullback : reversal;
  const score = blockReasons.length > 0 ? Math.min(selected.score, 49) : selected.score;
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
    reasons: selected.reasons.slice(0, 6),
    blockReasons,
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
  if (derived.recentReturnBps >= 8) score += add(16, "최근 가격 기울기가 상승으로 전환", reasons);
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
  if (derived.priorReturnBps >= 20) score += add(16, "눌림 전 상승 모멘텀 확인", reasons);
  if (derived.vwap !== null && candidate.currentPrice > derived.vwap) score += add(14, "현재가가 단기 VWAP 위", reasons);
  if (derived.pullbackDepthBps >= 20 && derived.pullbackDepthBps <= 250) {
    score += add(14, "과도하지 않은 짧은 눌림", reasons);
  }
  if (derived.recentReturnBps >= 8) score += add(16, "눌림 후 재상승", reasons);
  if (derived.volumeContractionRatio !== null && derived.volumeContractionRatio <= 0.9) {
    score += add(10, "눌림 구간 거래량 감소", reasons);
  }
  if (derived.bookImbalance >= 0.05) score += add(10, "재상승 시 매수호가 우위", reasons);
  if (orderBook.spreadTicks !== null && orderBook.spreadTicks <= 2) score += add(6, "스프레드 2틱 이하", reasons);
  if (candidate.accumulatedTradingValue >= 5_000_000_000) score += add(4, "거래대금 충분", reasons);
  return { type: "PULLBACK", score: Math.min(100, score), reasons };
}

function buildBlockReasons(candidate, bars, orderBook, derived, settings) {
  const reasons = [];
  if (candidate.tradingHalted) reasons.push("거래정지 또는 일시정지 상태");
  if (candidate.currentPrice === null) reasons.push("현재가 없음");
  if (candidate.accumulatedTradingValue < settings.minimumTradingValue) {
    reasons.push(`누적 거래대금 ${formatWon(settings.minimumTradingValue)} 미만`);
  }
  if (bars.length < 8) reasons.push("당일 분봉 데이터 8개 미만");
  if (orderBook.bestBid === null || orderBook.bestAsk === null) reasons.push("최우선 호가 없음");
  if (orderBook.spreadTicks !== null && orderBook.spreadTicks > 3) reasons.push("스프레드 3틱 초과");
  if (candidate.changePercent !== null && candidate.changePercent > settings.maximumDailyRisePercent) {
    reasons.push(`당일 상승률 ${settings.maximumDailyRisePercent}% 초과`);
  }
  if (derived.vwapExtensionBps !== null && derived.vwapExtensionBps > settings.maximumVwapExtensionBps) {
    reasons.push(`VWAP 상단 이격 ${settings.maximumVwapExtensionBps}bp 초과`);
  }
  if (derived.recentReturnBps > settings.maximumRecentRiseBps) {
    reasons.push(`최근 4개 분봉 상승 ${settings.maximumRecentRiseBps}bp 초과`);
  }
  if (derived.upperLimitDistanceBps !== null && derived.upperLimitDistanceBps <= settings.upperLimitProximityBps) {
    reasons.push(`상한가 ${settings.upperLimitProximityBps}bp 이내 근접`);
  }
  if (candidate.fetchedAt !== null && candidate.evaluatedAt - candidate.fetchedAt > 60_000) {
    reasons.push("시세 데이터 60초 초과 지연");
  }
  return reasons;
}

function calculateDerived(candidate, bars, orderBook) {
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
    tickSize: positiveOrNull(input.tickSize) ?? 1,
    orderBook: input.orderBook,
    minuteBars: input.minuteBars,
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
