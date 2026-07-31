const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const sumSize = (levels) => levels.reduce((sum, level) => sum + level.size, 0);

export function calculateMicrostructureMetrics({
  book,
  trades,
  tickSize,
  lookbackMs = 5_000,
  now = Date.now(),
}) {
  const bidSize = sumSize(book.bids);
  const askSize = sumSize(book.asks);
  const totalBookSize = bidSize + askSize;
  const imbalance = totalBookSize === 0 ? 0 : (bidSize - askSize) / totalBookSize;

  const weightedBid = book.bids.reduce((sum, level, index) => sum + level.size / (index + 1), 0);
  const weightedAsk = book.asks.reduce((sum, level, index) => sum + level.size / (index + 1), 0);
  const weightedTotal = weightedBid + weightedAsk;
  const weightedImbalance = weightedTotal === 0 ? 0 : (weightedBid - weightedAsk) / weightedTotal;

  const bestBid = book.bids[0]?.price ?? 0;
  const bestAsk = book.asks[0]?.price ?? bestBid;
  const spread = Math.max(0, bestAsk - bestBid);
  const spreadTicks = tickSize > 0 ? spread / tickSize : 0;

  const recentTrades = trades.filter((trade) => now - trade.timestamp <= lookbackMs);
  const buyVolume = recentTrades
    .filter((trade) => trade.side === "BUY")
    .reduce((sum, trade) => sum + trade.size, 0);
  const sellVolume = recentTrades
    .filter((trade) => trade.side === "SELL")
    .reduce((sum, trade) => sum + trade.size, 0);
  const totalTradeVolume = buyVolume + sellVolume;
  const tradeFlow = totalTradeVolume === 0 ? 0 : (buyVolume - sellVolume) / totalTradeVolume;

  const windowSeconds = Math.max(lookbackMs / 1_000, 1);
  const tradesPerSecond = recentTrades.length / windowSeconds;
  const volumePerSecond = totalTradeVolume / windowSeconds;
  const firstTrade = recentTrades[0];
  const lastTrade = recentTrades.at(-1);
  const momentumBps = firstTrade && lastTrade && firstTrade.price > 0
    ? ((lastTrade.price - firstTrade.price) / firstTrade.price) * 10_000
    : 0;

  const returns = [];
  for (let index = 1; index < recentTrades.length; index += 1) {
    const previous = recentTrades[index - 1];
    const current = recentTrades[index];
    if (previous && current && previous.price > 0) {
      returns.push((current.price - previous.price) / previous.price);
    }
  }
  const mean = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0;
  const variance = returns.length
    ? returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length
    : 0;
  const volatilityBps = Math.sqrt(variance) * 10_000;

  const spreadPenalty = clamp((spreadTicks - 1) * 12, 0, 36);
  const activityBoost = clamp((tradesPerSecond - 1.5) * 4, 0, 12);
  const direction = Math.sign(tradeFlow || weightedImbalance);
  const rawScore =
    weightedImbalance * 36 +
    tradeFlow * 34 +
    clamp(momentumBps / 2, -18, 18) +
    direction * activityBoost -
    direction * spreadPenalty;
  const score = Math.round(clamp(rawScore, -100, 100));
  const signal = score >= 35 ? "BUY" : score <= -35 ? "SELL" : "WAIT";
  const confidence = Math.round(clamp(Math.abs(score), 0, 100));

  const reasons = [];
  if (Math.abs(weightedImbalance) >= 0.18) {
    reasons.push(weightedImbalance > 0 ? "매수 1~3호가 잔량 우세" : "매도 1~3호가 잔량 우세");
  }
  if (Math.abs(tradeFlow) >= 0.18) {
    reasons.push(tradeFlow > 0 ? "최근 공격적 매수 체결 우세" : "최근 공격적 매도 체결 우세");
  }
  if (Math.abs(momentumBps) >= 1.5) {
    reasons.push(momentumBps > 0 ? "초단기 가격 모멘텀 상승" : "초단기 가격 모멘텀 하락");
  }
  if (spreadTicks <= 1) reasons.push("스프레드 1틱으로 체결 비용 안정");
  else if (spreadTicks >= 3) reasons.push("스프레드 확대 위험");
  if (reasons.length === 0) reasons.push("호가와 체결 방향이 아직 일치하지 않음");

  return {
    imbalance,
    weightedImbalance,
    tradeFlow,
    spread,
    spreadTicks,
    tradesPerSecond,
    volumePerSecond,
    momentumBps,
    volatilityBps,
    score,
    signal,
    confidence,
    reasons,
  };
}
