const EQUITY_EVENT = "BROKER_EQUITY_SNAPSHOT";
const FILL_EVENT = "BROKER_FILL_OBSERVED";

/**
 * 한국투자 모의계좌 잔고·주문내역을 실행 저널에 원시 이벤트(평가금액 스냅샷, 신규 체결 증분)로
 * 기록하고, 저장된 이벤트만으로 성과 통계·최대 낙폭·연속 손실을 계산한다.
 * FIFO 매칭 대상 매수 로트가 없는 매도 체결(추적 시작 이전 보유수량)은 실현손익 계산에서 제외되고
 * costBasisIncompleteQuantity로 별도 집계된다.
 */
export class KisPaperPerformanceTracker {
  constructor({ journal, now = Date.now, costModel = {} } = {}) {
    if (!journal || typeof journal.append !== "function" || typeof journal.readAll !== "function") {
      throw new TypeError("append/readAll을 제공하는 실행 저널이 필요합니다.");
    }
    if (typeof now !== "function") throw new TypeError("now는 함수여야 합니다.");
    this.journal = journal;
    this.now = now;
    this.costModel = { ...costModel };
    this.observedExecutedQuantity = new Map();
    this.replayJournal();
  }

  replayJournal() {
    for (const event of this.journal.readAll()) {
      if (event.type !== FILL_EVENT) continue;
      const payload = event?.payload ?? {};
      const key = fillKey(payload.orderOrganizationNumber, payload.orderNumber);
      const cumulative = number(payload.cumulativeExecutedQuantity);
      const previous = this.observedExecutedQuantity.get(key) ?? 0;
      if (cumulative > previous) this.observedExecutedQuantity.set(key, cumulative);
    }
  }

  record({ balance, orderHistory } = {}) {
    const capturedAt = this.now();
    const day = koreaDateKey(capturedAt);
    const summary = balance?.summary ?? {};
    const totalEvaluationAmount = finiteOrNull(summary.totalEvaluationAmount);
    if (totalEvaluationAmount !== null) {
      this.journal.append(EQUITY_EVENT, {
        day,
        capturedAt,
        totalEvaluationAmount,
        evaluationProfitLoss: finiteOrNull(summary.evaluationProfitLoss) ?? 0,
        cash: finiteOrNull(summary.cash),
      }, capturedAt);
    }

    const orders = Array.isArray(orderHistory?.orders) ? orderHistory.orders : [];
    for (const order of orders) {
      const orderNumber = text(order?.orderNumber);
      if (!orderNumber) continue;
      const executedQuantity = number(order?.executedQuantity);
      if (executedQuantity <= 0) continue;
      const key = fillKey(order?.orderOrganizationNumber, orderNumber);
      const previous = this.observedExecutedQuantity.get(key) ?? 0;
      const delta = executedQuantity - previous;
      if (delta <= 0) continue;
      this.observedExecutedQuantity.set(key, executedQuantity);
      this.journal.append(FILL_EVENT, {
        day,
        capturedAt,
        orderedAt: finiteOrNull(order?.orderedAt),
        orderNumber,
        orderOrganizationNumber: text(order?.orderOrganizationNumber),
        symbol: text(order?.symbol),
        side: text(order?.side)?.toUpperCase() ?? null,
        deltaQuantity: delta,
        executedPrice: number(order?.averageExecutedPrice),
        cumulativeExecutedQuantity: executedQuantity,
      }, capturedAt);
    }
  }

  report({ recentLimit } = {}) {
    return computePerformanceReport(this.journal.readAll(), {
      now: this.now(),
      costModel: this.costModel,
      ...(recentLimit === undefined ? {} : { recentLimit }),
    });
  }

  // 비용 모델은 추천 스캐너와 자동매매가 쓰는 값과 같아야 한다. 어긋나면 판정이 흔들린다.
  setCostModel(costModel) {
    this.costModel = { ...costModel };
    return this.costModel;
  }
}

const INCIDENT_EVENT_TYPES = new Set(["BROKER_ORDER_UNKNOWN", "BROKER_RECONCILIATION_MISMATCH"]);
const DAY_MS = 24 * 60 * 60 * 1_000;

// 왕복 비용(매수 수수료 + 매도 수수료 + 거래세)은 실현손익에 반드시 반영해야 한다.
// 반영하지 않으면 총이익 +0.1%짜리 전략이 실제로는 손실인데 플러스로 보인다.
// KIS 응답의 estimatedFeesAndTaxes는 일별 합계만 제공하므로 거래별 귀속은 모델로 계산하고,
// 그 값은 추정치임을 명시한다(실제 정산내역과 대사 필요).
const DEFAULT_COST_MODEL = Object.freeze({
  buyCommissionBps: 1.40527,
  sellCommissionBps: 1.40527,
  sellTaxBps: 20,
});

export function computePerformanceReport(events, { now = Date.now(), costModel = {}, recentLimit = 20 } = {}) {
  const costs = { ...DEFAULT_COST_MODEL, ...costModel };
  const operational = computeOperationalStats(events, now);
  const equitySnapshots = events
    .filter((event) => event.type === EQUITY_EVENT)
    .map((event) => event.payload)
    .sort((left, right) => left.capturedAt - right.capturedAt);

  const fillEvents = events
    .filter((event) => event.type === FILL_EVENT)
    .map((event) => event.payload)
    .sort((left, right) => (left.orderedAt ?? left.capturedAt) - (right.orderedAt ?? right.capturedAt));

  let peak = null;
  let maxDrawdownAmount = 0;
  let maxDrawdownPct = 0;
  for (const snapshot of equitySnapshots) {
    const equity = snapshot.totalEvaluationAmount;
    if (peak === null || equity > peak) peak = equity;
    if (peak !== null && peak > 0) {
      const drawdown = peak - equity;
      const drawdownPct = drawdown / peak;
      if (drawdown > maxDrawdownAmount) maxDrawdownAmount = drawdown;
      if (drawdownPct > maxDrawdownPct) maxDrawdownPct = drawdownPct;
    }
  }
  const latestEquity = equitySnapshots.at(-1) ?? null;
  const currentDrawdownAmount = latestEquity && peak !== null
    ? Math.max(0, peak - latestEquity.totalEvaluationAmount)
    : 0;
  const currentDrawdownPct = peak && peak > 0 ? currentDrawdownAmount / peak : 0;

  const lotsBySymbol = new Map();
  const realizedTrades = [];
  let costBasisIncompleteQuantity = 0;
  for (const fill of fillEvents) {
    const symbol = fill.symbol;
    if (!symbol || !fill.side || fill.deltaQuantity <= 0) continue;
    if (fill.side === "BUY") {
      const lots = lotsBySymbol.get(symbol) ?? [];
      lots.push({ quantity: fill.deltaQuantity, price: fill.executedPrice });
      lotsBySymbol.set(symbol, lots);
      continue;
    }
    if (fill.side !== "SELL") continue;
    const lots = lotsBySymbol.get(symbol) ?? [];
    let remaining = fill.deltaQuantity;
    let matchedQuantity = 0;
    let costBasis = 0;
    while (remaining > 0 && lots.length > 0) {
      const lot = lots[0];
      const take = Math.min(lot.quantity, remaining);
      matchedQuantity += take;
      costBasis += take * lot.price;
      lot.quantity -= take;
      remaining -= take;
      if (lot.quantity <= 0) lots.shift();
    }
    if (remaining > 0) costBasisIncompleteQuantity += remaining;
    if (matchedQuantity > 0) {
      const proceeds = matchedQuantity * fill.executedPrice;
      const buyCost = costBasis * (costs.buyCommissionBps / 10_000);
      const sellCost = proceeds * (costs.sellCommissionBps / 10_000);
      const taxCost = proceeds * (costs.sellTaxBps / 10_000);
      const totalCost = buyCost + sellCost + taxCost;
      const grossPnl = proceeds - costBasis;
      realizedTrades.push({
        symbol,
        quantity: matchedQuantity,
        buyAveragePrice: costBasis / matchedQuantity,
        sellPrice: fill.executedPrice,
        // realizedPnl은 기존 계약을 유지한다(총손익). 비용 차감 후 값은 netPnl이다.
        realizedPnl: grossPnl,
        grossPnl,
        buyCost,
        sellCost,
        taxCost,
        totalCost,
        netPnl: grossPnl - totalCost,
        closedAt: fill.orderedAt ?? fill.capturedAt,
        orderNumber: fill.orderNumber,
        costBasisIncomplete: remaining > 0,
      });
    }
  }

  const wins = realizedTrades.filter((trade) => trade.realizedPnl > 0);
  const losses = realizedTrades.filter((trade) => trade.realizedPnl < 0);
  const totalRealizedPnl = realizedTrades.reduce((sum, trade) => sum + trade.realizedPnl, 0);
  // 판정은 비용 차감 후 기준으로 한다(docs/AUTO_TRADING_PAPER_DESIGN.md §8).
  const netWins = realizedTrades.filter((trade) => trade.netPnl > 0);
  const netLosses = realizedTrades.filter((trade) => trade.netPnl < 0);
  const totalNetPnl = realizedTrades.reduce((sum, trade) => sum + trade.netPnl, 0);
  const totalCost = realizedTrades.reduce((sum, trade) => sum + trade.totalCost, 0);

  let consecutiveLossStreak = 0;
  for (let index = realizedTrades.length - 1; index >= 0; index -= 1) {
    if (realizedTrades[index].realizedPnl < 0) consecutiveLossStreak += 1;
    else break;
  }
  let maxConsecutiveLossStreak = 0;
  let running = 0;
  for (const trade of realizedTrades) {
    if (trade.realizedPnl < 0) {
      running += 1;
      maxConsecutiveLossStreak = Math.max(maxConsecutiveLossStreak, running);
    } else {
      running = 0;
    }
  }

  return {
    generatedAt: now,
    operational,
    costModel: {
      ...costs,
      source: "CONFIGURED_ESTIMATE",
      warning: "거래별 비용은 설정값 기반 추정치입니다. 실제 계좌 정산내역과 반드시 대사하세요.",
    },
    equity: {
      snapshotCount: equitySnapshots.length,
      current: latestEquity?.totalEvaluationAmount ?? null,
      peak,
      maxDrawdownAmount,
      maxDrawdownPct,
      currentDrawdownAmount,
      currentDrawdownPct,
    },
    trades: {
      realizedCount: realizedTrades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: realizedTrades.length > 0 ? wins.length / realizedTrades.length : null,
      totalRealizedPnl,
      netWins: netWins.length,
      netLosses: netLosses.length,
      netWinRate: realizedTrades.length > 0 ? netWins.length / realizedTrades.length : null,
      totalNetPnl,
      totalCost,
      averageNetWin: netWins.length > 0
        ? netWins.reduce((sum, trade) => sum + trade.netPnl, 0) / netWins.length : null,
      averageNetLoss: netLosses.length > 0
        ? netLosses.reduce((sum, trade) => sum + trade.netPnl, 0) / netLosses.length : null,
      averageWin: wins.length > 0 ? wins.reduce((sum, trade) => sum + trade.realizedPnl, 0) / wins.length : null,
      averageLoss: losses.length > 0 ? losses.reduce((sum, trade) => sum + trade.realizedPnl, 0) / losses.length : null,
      consecutiveLossStreak,
      maxConsecutiveLossStreak,
      costBasisIncompleteQuantity,
      recent: recentLimit > 0 ? realizedTrades.slice(-recentLimit) : realizedTrades,
    },
  };
}

// "충분한 모의투자 기간"은 자동으로 판정하지 않는다. 사고(UNKNOWN_RESULT, 계좌 대사 불일치) 발생
// 이후 경과일수를 노출해, 실전 전환 여부를 사용자가 직접 판단할 수 있는 참고 지표만 제공한다.
function computeOperationalStats(events, now) {
  const timestamps = events.map((event) => number(event?.timestamp)).filter((value) => value > 0);
  const trackingStartedAt = timestamps.length > 0 ? Math.min(...timestamps) : null;
  const incidentTimestamps = events
    .filter((event) => INCIDENT_EVENT_TYPES.has(event.type))
    .map((event) => number(event?.timestamp))
    .filter((value) => value > 0);
  const lastIncidentAt = incidentTimestamps.length > 0 ? Math.max(...incidentTimestamps) : null;
  const daysSinceLastIncident = lastIncidentAt !== null
    ? Math.floor((now - lastIncidentAt) / DAY_MS)
    : trackingStartedAt !== null
      ? Math.floor((now - trackingStartedAt) / DAY_MS)
      : null;
  return {
    trackingStartedAt,
    lastIncidentAt,
    daysSinceLastIncident,
    note: "실전 전환 게이트가 아닌 참고 지표입니다. 충분한 관찰 기간인지는 사용자가 직접 판단해야 합니다.",
  };
}

function fillKey(organizationNumber, orderNumber) {
  return `${text(organizationNumber) ?? "*"}:${text(orderNumber) ?? ""}`;
}

function koreaDateKey(timestamp) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function text(value) {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result || null;
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function finiteOrNull(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
