// minimumExecutionStrength(체결강도) 100은 "매수 체결량이 매도 체결량과 같거나
// 더 많아야 함"을 뜻한다 — 반전형(하락 후 반등 노리는) 후보는 반등이 막 시작된
// 순간엔 매도세가 아직 다 안 꺼져 있어서 이 기준을 거의 못 넘는다(2026-09-23,
// 호가 불균형은 여유 있게 통과하는데 체결강도만 93~99 근처에서 계속 못 넘어
// 8분간 20여 회 평가 전부 적격 후보 0건이었다). 다른 하드 기준(호가 불균형
// 5%, 스프레드 25bp)은 그대로 두고 이것만 80으로 낮춘다.
const DEFAULTS = Object.freeze({
  staleAfterMs: 5_000,
  maxSpreadBps: 25,
  minimumBookImbalance: 0.05,
  minimumExecutionStrength: 80,
  maximumRealtimeChaseBps: 150,
});

export function evaluateRealtimeConfirmation(candidate, realtimeSnapshot, options = {}) {
  const settings = normalizeOptions(options);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const snapshot = realtimeSnapshot && typeof realtimeSnapshot === "object"
    ? realtimeSnapshot
    : null;
  const orderBook = snapshot?.orderBook ?? null;
  const trade = snapshot?.trade ?? null;
  const metrics = calculateMetrics(orderBook, trade);
  const base = {
    state: "SCANNED",
    provisional: true,
    automaticOrderConnected: false,
    checkedAt: now,
    latestAt: snapshot?.latestAt ?? null,
    venue: snapshot?.venue ?? null,
    reasons: [],
    metrics,
  };

  if (candidate?.stage === "BLOCKED") {
    return {
      ...base,
      state: "BLOCKED",
      reasons: Array.isArray(candidate.blockReasons) && candidate.blockReasons.length > 0
        ? [...candidate.blockReasons]
        : ["REST 안전 필터에서 차단된 후보입니다."],
    };
  }

  if (!snapshot) {
    return { ...base, state: "SCANNED", reasons: ["실시간 확인 서비스가 연결되지 않았습니다."] };
  }
  if (!snapshot.connected || snapshot.connectionState !== "CONNECTED") {
    return { ...base, state: "DISCONNECTED", reasons: ["KIS WebSocket 연결이 끊겨 있습니다."] };
  }
  if (!orderBook || !trade) {
    return {
      ...base,
      state: "REALTIME_CONFIRMING",
      reasons: [
        !orderBook && !trade
          ? "실시간 호가와 체결 수신을 기다리고 있습니다."
          : !orderBook
            ? "실시간 호가 수신을 기다리고 있습니다."
            : "실시간 체결 수신을 기다리고 있습니다.",
      ],
    };
  }

  const latestAt = Math.min(orderBook.receivedAt ?? 0, trade.receivedAt ?? 0);
  const stale = latestAt <= 0 || now - latestAt > settings.staleAfterMs
    || snapshot.orderBookAgeMs > settings.staleAfterMs
    || snapshot.tradeAgeMs > settings.staleAfterMs;
  if (stale) {
    return {
      ...base,
      state: "STALE",
      reasons: [`실시간 호가·체결 중 하나가 ${settings.staleAfterMs}ms 이상 지연되었습니다.`],
    };
  }

  const hardBlocks = [];
  if (trade.tradingHalted) hardBlocks.push("실시간 체결에서 거래정지 상태가 확인됐습니다.");
  if (metrics.spreadBps === null) hardBlocks.push("실시간 최우선 매수·매도 호가가 없습니다.");
  else if (metrics.spreadBps > settings.maxSpreadBps) {
    hardBlocks.push(`실시간 스프레드 ${format(metrics.spreadBps)}bp가 ${settings.maxSpreadBps}bp를 초과했습니다.`);
  }
  if (metrics.vwapExtensionBps !== null && metrics.vwapExtensionBps > settings.maximumRealtimeChaseBps) {
    hardBlocks.push(`실시간 가중평균가 상단 이격 ${format(metrics.vwapExtensionBps)}bp가 추격 제한을 초과했습니다.`);
  }
  if (hardBlocks.length > 0) {
    return { ...base, state: "BLOCKED", reasons: hardBlocks };
  }

  const watchReasons = [];
  if (metrics.bookImbalance === null || metrics.bookImbalance < settings.minimumBookImbalance) {
    watchReasons.push(`매수호가 불균형이 ${format(settings.minimumBookImbalance * 100)}% 기준에 미달합니다.`);
  }
  if (metrics.executionStrength === null || metrics.executionStrength < settings.minimumExecutionStrength) {
    watchReasons.push(`체결강도가 ${settings.minimumExecutionStrength} 기준에 미달합니다.`);
  }
  if (candidate?.stage !== "CONFIRMATION_REQUIRED") {
    watchReasons.push("REST 점수가 실시간 진입 확인 대상 단계에 도달하지 않았습니다.");
  }

  if (watchReasons.length > 0) {
    return { ...base, state: "WATCH", reasons: watchReasons };
  }

  return {
    ...base,
    state: "ENTRY_READY",
    reasons: [
      "실시간 호가·체결이 모두 최신입니다.",
      "스프레드, 매수호가 불균형, 체결강도, 추격 제한 조건을 통과했습니다.",
      "분석 상태일 뿐 주문 실행 신호와 연결되지 않습니다.",
    ],
  };
}

export function summarizeRealtimeStates(candidates) {
  const counts = {
    SCANNED: 0,
    WATCH: 0,
    REALTIME_CONFIRMING: 0,
    ENTRY_READY: 0,
    BLOCKED: 0,
    STALE: 0,
    DISCONNECTED: 0,
  };
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const state = candidate?.realtime?.state;
    if (Object.hasOwn(counts, state)) counts[state] += 1;
  }
  return counts;
}

function calculateMetrics(orderBook, trade) {
  const bestAsk = numberOrNull(orderBook?.bestAsk ?? trade?.bestAsk);
  const bestBid = numberOrNull(orderBook?.bestBid ?? trade?.bestBid);
  const midpoint = bestAsk !== null && bestBid !== null ? (bestAsk + bestBid) / 2 : null;
  const spread = bestAsk !== null && bestBid !== null ? Math.max(0, bestAsk - bestBid) : null;
  const totalAskSize = numberOrNull(orderBook?.totalAskSize ?? trade?.totalAskSize);
  const totalBidSize = numberOrNull(orderBook?.totalBidSize ?? trade?.totalBidSize);
  const totalBook = (totalAskSize ?? 0) + (totalBidSize ?? 0);
  const currentPrice = numberOrNull(trade?.currentPrice);
  const weightedAveragePrice = numberOrNull(trade?.weightedAveragePrice);
  return {
    currentPrice,
    bestAsk,
    bestBid,
    spread,
    spreadBps: spread !== null && midpoint > 0 ? round((spread / midpoint) * 10_000, 3) : null,
    totalAskSize,
    totalBidSize,
    bookImbalance: totalBook > 0 ? round(((totalBidSize ?? 0) - (totalAskSize ?? 0)) / totalBook, 4) : null,
    executionStrength: numberOrNull(trade?.executionStrength),
    weightedAveragePrice,
    vwapExtensionBps: currentPrice !== null && weightedAveragePrice !== null && weightedAveragePrice > 0
      ? round(((currentPrice - weightedAveragePrice) / weightedAveragePrice) * 10_000, 3)
      : null,
    tradeVolume: numberOrNull(trade?.tradeVolume),
    accumulatedTradingValue: numberOrNull(trade?.accumulatedTradingValue),
    viStandardPrice: numberOrNull(trade?.viStandardPrice),
  };
}

function normalizeOptions(value) {
  const input = value && typeof value === "object" ? value : {};
  return {
    staleAfterMs: positive(input.staleAfterMs, DEFAULTS.staleAfterMs),
    maxSpreadBps: nonNegative(input.maxSpreadBps, DEFAULTS.maxSpreadBps),
    minimumBookImbalance: bounded(input.minimumBookImbalance, DEFAULTS.minimumBookImbalance, -1, 1),
    minimumExecutionStrength: nonNegative(input.minimumExecutionStrength, DEFAULTS.minimumExecutionStrength),
    maximumRealtimeChaseBps: nonNegative(input.maximumRealtimeChaseBps, DEFAULTS.maximumRealtimeChaseBps),
  };
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function bounded(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : fallback;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits) {
  const power = 10 ** digits;
  return Math.round(value * power) / power;
}

function format(value) {
  return Number.isFinite(value) ? String(round(value, 2)) : "-";
}
