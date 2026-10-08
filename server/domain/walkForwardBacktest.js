import { calculateMicrostructureMetrics } from "./analysis.js";
import { PaperTrader } from "./paperTrader.js";
import { PositionRiskTracker } from "./positionRiskTracker.js";
import { normalizeStrategySettings } from "./strategySettings.js";
import { evaluateAutoStrategy } from "./strategyPolicy.js";

const DEFAULT_WINDOW_COUNT = 4;
const DEFAULT_INITIAL_CASH = 10_000_000;
const DEFAULT_LOOKBACK_MS = 5_000;

/**
 * 실시간 연구 기록(server/domain/realtimeResearchJournal.js)에 저장된 실제 KIS 호가·체결로,
 * 저장된 여러 전략 설정 버전(StrategySettingsStore.history())을 시간 구간(윈도우)별로 순차 적용해
 * 내부 SIMULATION과 동일한 evaluateAutoStrategy + PaperTrader 조합으로 가상 성과를 계산한다.
 * 자동 스케줄링·실거래 연동이 없는 수동 진단 도구이며, 실전 전환을 판정하지 않는다.
 */
export function runWalkForwardBacktest({
  events,
  strategySettingsVersions,
  windowCount = DEFAULT_WINDOW_COUNT,
  initialCash = DEFAULT_INITIAL_CASH,
  costModel = {},
  lookbackMs = DEFAULT_LOOKBACK_MS,
} = {}) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new TypeError("events는 비어 있지 않은 배열이어야 합니다.");
  }
  if (!Array.isArray(strategySettingsVersions) || strategySettingsVersions.length === 0) {
    throw new TypeError("strategySettingsVersions는 비어 있지 않은 배열이어야 합니다.");
  }
  if (!Number.isInteger(windowCount) || windowCount < 1) {
    throw new TypeError("windowCount는 1 이상의 정수여야 합니다.");
  }

  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const timelines = buildSymbolTimelines(ordered, lookbackMs);
  const firstTimestamp = ordered[0]?.timestamp ?? null;
  const lastTimestamp = ordered.at(-1)?.timestamp ?? null;
  const windows = buildWindows(firstTimestamp, lastTimestamp, windowCount);

  const results = [];
  for (const version of strategySettingsVersions) {
    const settings = normalizeStrategySettings(version.next ?? version);
    for (const [windowIndex, window] of windows.entries()) {
      const perSymbol = [];
      for (const [symbol, entries] of timelines) {
        const inWindow = entries.filter((entry) => entry.timestamp >= window.startAt && entry.timestamp < window.endAt);
        if (inWindow.length === 0) continue;
        perSymbol.push({ symbol, ...simulateSymbolWindow(inWindow, settings, { initialCash, costModel }) });
      }
      results.push({
        version: version.version ?? null,
        windowIndex,
        windowStartAt: window.startAt,
        windowEndAt: window.endAt,
        symbolCount: perSymbol.length,
        totalRealizedPnl: round(perSymbol.reduce((sum, item) => sum + item.realizedPnl, 0), 2),
        totalFillCount: perSymbol.reduce((sum, item) => sum + item.fillCount, 0),
        totalOrderCount: perSymbol.reduce((sum, item) => sum + item.orderCount, 0),
        averageMaxDrawdownPct: perSymbol.length
          ? round(perSymbol.reduce((sum, item) => sum + item.maxDrawdownPct, 0) / perSymbol.length, 4)
          : null,
        perSymbol,
      });
    }
  }

  return {
    model: "WALK_FORWARD_DIAGNOSTIC_NO_LIVE_ORDER_MODEL",
    warnings: [
      "실전 전환 여부를 판정하는 도구가 아니라 저장된 전략 설정 버전들의 구간별 상대 성과를 비교하는 진단 스크립트입니다.",
      "기록된 실시간 호가·체결만 재생하며 숨은 유동성, 실제 주문 큐 순서, 네트워크·거래소 지연은 반영하지 않습니다.",
      "자동 스케줄링이나 실거래 연동을 하지 않으며 수동으로 실행합니다.",
    ],
    firstTimestamp,
    lastTimestamp,
    windowCount: windows.length,
    windows,
    symbolsObserved: [...timelines.keys()],
    versionsCompared: strategySettingsVersions.map((version) => version.version ?? null),
    results,
  };
}

function simulateSymbolWindow(entries, settings, { initialCash, costModel }) {
  const trader = new PaperTrader(initialCash, { now: () => entries.at(-1).timestamp, costModel });
  const positionRiskTracker = new PositionRiskTracker();
  let lastOrderAt = 0;
  let orderCount = 0;
  let peakEquity = initialCash;
  let maxDrawdownPct = 0;

  for (const entry of entries) {
    const positionQuantity = trader.account.position.quantity;
    const positionRiskState = positionRiskTracker.update({
      quantity: positionQuantity,
      lastPrice: entry.lastPrice,
      timestamp: entry.timestamp,
    });

    let intent = evaluateAutoStrategy({
      metrics: entry.metrics,
      account: trader.snapshot(entry.lastPrice),
      settings,
      now: entry.timestamp,
      lastOrderAt,
      lastPrice: entry.lastPrice,
      positionRiskState,
    });

    if (intent) {
      if (intent.side === "SELL") {
        for (const order of trader.account.orders.filter((item) => item.isOpen)) {
          trader.cancel(order.id, { reason: `전략 청산(${intent.reason}) 전 대기 주문 취소`, timestamp: entry.timestamp });
        }
        const currentQuantity = trader.account.position.quantity;
        if (!Number.isInteger(currentQuantity) || currentQuantity <= 0) intent = null;
        else intent = { ...intent, quantity: currentQuantity };
      }
    }

    if (intent) {
      orderCount += 1;
      const order = trader.submit({
        side: intent.side,
        type: "MARKET",
        quantity: intent.quantity,
        tickSize: entry.tickSize,
        referencePrice: entry.lastPrice,
        source: "STRATEGY",
        killSwitch: false,
        marketDataAvailable: true,
        clientOrderId: `walk-forward-${entry.timestamp}-${orderCount}`,
        timestamp: entry.timestamp,
        book: entry.book,
      });
      if (order.status !== "REJECTED" && order.status !== "CANCELLED") lastOrderAt = entry.timestamp;
    }

    const equity = trader.snapshot(entry.lastPrice).equity;
    if (equity > peakEquity) peakEquity = equity;
    if (peakEquity > 0) {
      const drawdownPct = Math.max(0, (peakEquity - equity) / peakEquity);
      if (drawdownPct > maxDrawdownPct) maxDrawdownPct = drawdownPct;
    }
  }

  const lastEntry = entries.at(-1);
  const finalSnapshot = trader.snapshot(lastEntry.lastPrice);
  return {
    realizedPnl: round(trader.account.realizedPnl, 2),
    finalEquity: round(finalSnapshot.equity, 2),
    finalPositionQuantity: finalSnapshot.position.quantity,
    fillCount: trader.account.fills.length,
    orderCount,
    maxDrawdownPct: round(maxDrawdownPct, 4),
  };
}

function buildSymbolTimelines(events, lookbackMs) {
  const tickSizeBySymbol = new Map();
  const tradesBySymbol = new Map();
  const timelines = new Map();

  for (const event of events) {
    if (event.type === "SCANNER_REFRESH") {
      for (const candidate of event.payload?.candidates ?? []) {
        const symbol = candidate?.symbol ? String(candidate.symbol) : null;
        const tickSize = Number(candidate?.orderBook?.tickSize ?? candidate?.tickSize);
        if (symbol && Number.isFinite(tickSize) && tickSize > 0) tickSizeBySymbol.set(symbol, tickSize);
      }
      continue;
    }
    if (event.type !== "REALTIME_MARKET_DATA") continue;

    const snapshot = event.payload?.snapshot ?? event.payload;
    const symbol = snapshot?.symbol ? String(snapshot.symbol) : null;
    if (!symbol) continue;
    const tickSize = tickSizeBySymbol.get(symbol);
    if (!Number.isFinite(tickSize) || tickSize <= 0) continue;

    const orderBook = snapshot.orderBook ?? null;
    const trade = snapshot.trade ?? null;
    const trades = tradesBySymbol.get(symbol) ?? [];
    const tradePrice = numberOrNull(trade?.currentPrice);
    const tradeVolume = numberOrNull(trade?.tradeVolume);
    if (tradePrice !== null && tradeVolume !== null && tradeVolume > 0) {
      const key = `${trade.businessDate ?? ""}:${trade.tradeTime ?? ""}:${tradePrice}:${tradeVolume}`;
      if (trades.at(-1)?.key !== key) {
        const side = classifyTradeSide({ price: tradePrice, orderBook, previous: trades.at(-1) });
        trades.push({ key, timestamp: event.timestamp, price: tradePrice, size: tradeVolume, side });
        if (trades.length > 600) trades.splice(0, trades.length - 600);
      }
      tradesBySymbol.set(symbol, trades);
    }

    const book = { bids: orderBook?.bids ?? [], asks: orderBook?.asks ?? [] };
    if (book.bids.length === 0 || book.asks.length === 0) continue;
    const lastPrice = tradePrice ?? numberOrNull(book.asks[0]?.price) ?? numberOrNull(book.bids[0]?.price);
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) continue;

    const metrics = calculateMicrostructureMetrics({ book, trades, tickSize, lookbackMs, now: event.timestamp });
    const list = timelines.get(symbol) ?? [];
    list.push({ timestamp: event.timestamp, metrics, lastPrice, book, tickSize });
    timelines.set(symbol, list);
  }
  return timelines;
}

function buildWindows(firstTimestamp, lastTimestamp, windowCount) {
  if (firstTimestamp === null || lastTimestamp === null || lastTimestamp <= firstTimestamp) {
    return [{ startAt: firstTimestamp ?? 0, endAt: (lastTimestamp ?? firstTimestamp ?? 0) + 1 }];
  }
  const span = lastTimestamp - firstTimestamp;
  const size = Math.max(1, Math.ceil(span / windowCount));
  const windows = [];
  for (let index = 0; index < windowCount; index += 1) {
    const startAt = firstTimestamp + index * size;
    const endAt = index === windowCount - 1 ? lastTimestamp + 1 : startAt + size;
    windows.push({ startAt, endAt });
  }
  return windows;
}

function classifyTradeSide({ price, orderBook, previous }) {
  const bestAsk = numberOrNull(orderBook?.bestAsk ?? orderBook?.asks?.[0]?.price);
  const bestBid = numberOrNull(orderBook?.bestBid ?? orderBook?.bids?.[0]?.price);
  if (bestAsk !== null && price >= bestAsk) return "BUY";
  if (bestBid !== null && price <= bestBid) return "SELL";
  if (previous && price > previous.price) return "BUY";
  if (previous && price < previous.price) return "SELL";
  return previous?.side ?? "BUY";
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
