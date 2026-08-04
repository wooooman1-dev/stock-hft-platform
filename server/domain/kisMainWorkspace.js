import { EventEmitter } from "node:events";
import { calculateMicrostructureMetrics } from "./analysis.js";

const EMPTY_METRICS = Object.freeze({
  imbalance: 0,
  weightedImbalance: 0,
  tradeFlow: 0,
  spread: 0,
  spreadTicks: 0,
  tradesPerSecond: 0,
  volumePerSecond: 0,
  momentumBps: 0,
  volatilityBps: 0,
  score: 0,
  signal: "WAIT",
  confidence: 0,
  reasons: ["KIS 실제 호가·체결 데이터를 기다리는 중입니다."],
});

export class KisMainWorkspace extends EventEmitter {
  constructor({
    selection,
    quoteClient = null,
    marketDataClient = null,
    realtimeClient = null,
    paperService = null,
    paperClient = null,
    paperLimits = {},
    strategySettings = null,
    now = Date.now,
    marketRefreshMs = 30_000,
    accountRefreshMs = 5_000,
    orderHistoryRefreshMs = 15_000,
  } = {}) {
    super();
    if (typeof now !== "function") throw new TypeError("now는 함수여야 합니다.");
    this.selection = normalizeSelection(selection, now());
    this.quoteClient = quoteClient;
    this.marketDataClient = marketDataClient;
    this.realtimeClient = realtimeClient;
    this.paperService = paperService;
    this.paperClient = paperClient;
    this.paperLimits = normalizeLimits(paperLimits);
    this.strategySettings = strategySettings ? structuredClone(strategySettings) : null;
    this.now = now;
    this.marketRefreshMs = positiveInteger(marketRefreshMs, "marketRefreshMs");
    this.accountRefreshMs = positiveInteger(accountRefreshMs, "accountRefreshMs");
    this.orderHistoryRefreshMs = positiveInteger(orderHistoryRefreshMs, "orderHistoryRefreshMs");
    this.started = false;
    this.timer = null;
    this.marketRefreshPromise = null;
    this.accountRefreshPromise = null;
    this.quote = selectionQuote(this.selection, this.now());
    this.restOrderBook = emptyBook();
    this.realtimeSnapshot = null;
    this.trades = [];
    this.candles = [];
    this.balance = null;
    this.cancelableOrders = [];
    this.orderHistory = null;
    this.marketError = null;
    this.accountError = null;
    this.orderHistoryError = null;
    this.lastMarketRefreshAt = 0;
    this.lastAccountRefreshAt = 0;
    this.lastOrderHistoryRefreshAt = 0;
    this.listeners = null;
    this.bindRealtime();
  }

  start() {
    if (this.started) return this.snapshot();
    this.started = true;
    this.watchSelection();
    void this.refreshAll();
    const interval = Math.max(1_000, Math.min(this.marketRefreshMs, this.accountRefreshMs));
    this.timer = setInterval(() => this.refreshDue(), interval);
    return this.snapshot();
  }

  stop() {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unbindRealtime();
  }

  snapshot() {
    const now = this.now();
    const realtime = this.realtimeSnapshot;
    const realtimeBook = realtime?.orderBook;
    const realtimeTrade = realtime?.trade;
    const book = validBook(realtimeBook) ? normalizeBook(realtimeBook) : normalizeBook(this.restOrderBook);
    const lastPrice = positiveNumberOr(
      realtimeTrade?.currentPrice,
      positiveNumberOr(this.quote?.currentPrice, this.selection.initialPrice),
    );
    const previousClose = positiveNumberOr(
      this.quote?.basePrice,
      this.selection.previousClose,
    );
    const tickSize = positiveNumberOr(this.quote?.askUnit, this.selection.tickSize);
    const metricTrades = this.trades.filter((trade) => Number.isFinite(trade.timestamp));
    const metrics = book.asks.length > 0 && book.bids.length > 0
      ? calculateMicrostructureMetrics({
        book,
        trades: metricTrades,
        tickSize,
        now,
      })
      : structuredClone(EMPTY_METRICS);
    const account = mapPaperAccount({
      balance: this.balance,
      symbol: this.selection.symbol,
      cancelableOrders: this.cancelableOrders,
      orderHistory: this.orderHistory,
      paperEnabled: Boolean(this.paperService),
      accountError: this.accountError,
      orderHistoryError: this.orderHistoryError,
    });
    account.commands = mapPaperCommands(this.paperService);
    const paperStatus = this.paperService?.status?.() ?? {
      killSwitch: false,
      unknownResult: false,
      automaticStrategyConnected: false,
    };
    const realtimeStatus = this.realtimeClient?.status?.() ?? {
      state: "DISABLED",
      connected: false,
      lastMessageAt: null,
      freshestDataAgeMs: null,
    };
    const latestMarketAt = Math.max(
      Number(realtime?.latestAt) || 0,
      Number(this.quote?.fetchedAt) || 0,
      Number(this.restOrderBook?.fetchedAt) || 0,
      this.lastMarketRefreshAt,
    ) || null;
    return {
      symbol: this.selection.symbol,
      symbolName: this.selection.symbolName,
      instrument: {
        market: this.selection.market,
        securityType: this.selection.securityType,
        priceSource: "KIS_PROD_READ_ONLY",
        quoteFetchedAt: this.quote?.fetchedAt ?? null,
        selectedAt: this.selection.selectedAt,
        simulation: false,
      },
      timestamp: latestMarketAt ?? now,
      lastPrice,
      previousClose,
      changePercent: finiteNumberOr(
        realtimeTrade?.changePercent,
        finiteNumberOr(this.quote?.changePercent, percentageChange(lastPrice, previousClose)),
      ),
      book,
      trades: this.trades.slice(-30).reverse(),
      candles: this.candles.slice(-180),
      metrics,
      account,
      riskLimits: {
        maxOrderQuantity: this.paperLimits.maxOrderQuantity,
        maxOrderValue: this.paperLimits.maxOrderValue,
        maxDailyOrders: this.paperLimits.maxDailyOrders,
        maxDailyLoss: this.paperLimits.maxDailyLoss,
      },
      tickSize,
      strategy: {
        settings: this.strategySettings ? structuredClone(this.strategySettings) : null,
        lastAutoOrderAt: 0,
        enabledOnRestart: false,
        riskState: null,
      },
      system: {
        mode: "KIS_PROD_READ_ONLY",
        accountMode: "KIS_PAPER_TRADING",
        feedConnected: Boolean(realtimeStatus.connected),
        feedState: realtimeStatus.state ?? "DISABLED",
        feedStale: Boolean(realtime?.stale),
        marketDataSource: validBook(realtimeBook) || realtimeTrade?.currentPrice
          ? "KIS_WEBSOCKET"
          : this.quote?.source === "KIS"
            ? "KIS_REST"
            : "KIS_NOT_CONNECTED",
        killSwitch: Boolean(paperStatus.killSwitch),
        unknownResult: Boolean(paperStatus.unknownResult),
        autoPaperTrading: false,
        automaticStrategyConnected: false,
        recommendationAutomaticOrderConnected: false,
        latencyMs: finiteNumberOr(realtimeStatus.freshestDataAgeMs, 0),
        lastEventAt: latestMarketAt,
        executionModel: "KIS_PAPER_MANUAL_ONLY",
        marketError: this.marketError,
        accountError: this.accountError,
        orderHistoryError: this.orderHistoryError,
      },
    };
  }

  async switchInstrument(selection) {
    this.selection = normalizeSelection(selection, this.now());
    this.quote = selectionQuote(this.selection, this.now());
    this.restOrderBook = emptyBook();
    this.realtimeSnapshot = null;
    this.trades = [];
    this.candles = [];
    this.marketError = null;
    this.watchSelection();
    this.emitSnapshot();
    await this.refreshAll();
    return { changed: true, snapshot: this.snapshot() };
  }

  async refreshAll() {
    await Promise.allSettled([
      this.refreshMarket(),
      this.refreshAccount({ forceOrderHistory: true }),
    ]);
    return this.snapshot();
  }

  async refreshMarket() {
    if (this.marketRefreshPromise) return this.marketRefreshPromise;
    this.marketRefreshPromise = this.performMarketRefresh().finally(() => {
      this.marketRefreshPromise = null;
    });
    return this.marketRefreshPromise;
  }

  async performMarketRefresh() {
    if (!this.quoteClient || !this.marketDataClient) {
      this.marketError = {
        code: "KIS_PROD_READ_ONLY_DISABLED",
        message: "한국투자 실전 시세 읽기 전용 연결이 비활성화되어 있습니다.",
      };
      this.emitSnapshot();
      return this.snapshot();
    }
    try {
      const quote = await this.quoteClient.getCurrentPrice({
        symbol: this.selection.symbol,
        market: "UN",
      });
      const orderBook = await this.marketDataClient.getOrderBook({
        symbol: this.selection.symbol,
        market: "UN",
      });
      const minuteBars = await this.marketDataClient.getMinuteBars({
        symbol: this.selection.symbol,
        market: "UN",
      });
      this.quote = quote;
      this.restOrderBook = orderBook;
      this.candles = normalizeMinuteBars(minuteBars, quote.fetchedAt ?? this.now());
      this.lastMarketRefreshAt = this.now();
      this.marketError = null;
      this.emitSnapshot();
      return this.snapshot();
    } catch (error) {
      this.marketError = safeError(error, "KIS_MARKET_REFRESH_FAILED");
      this.emitSnapshot();
      return this.snapshot();
    }
  }

  async refreshAccount({ forceOrderHistory = false } = {}) {
    if (this.accountRefreshPromise) {
      if (!forceOrderHistory) return this.accountRefreshPromise;
      await this.accountRefreshPromise;
      return this.refreshAccount({ forceOrderHistory: true });
    }
    this.accountRefreshPromise = this.performAccountRefresh({ forceOrderHistory }).finally(() => {
      this.accountRefreshPromise = null;
    });
    return this.accountRefreshPromise;
  }

  async performAccountRefresh({ forceOrderHistory = false } = {}) {
    if (!this.paperService) {
      this.accountError = {
        code: "KIS_PAPER_DISABLED",
        message: "한국투자 모의투자 계좌 연결이 비활성화되어 있습니다.",
      };
      this.emitSnapshot();
      return this.snapshot();
    }
    try {
      const now = this.now();
      const shouldRefreshOrderHistory = Boolean(this.paperClient?.getDailyOrders)
        && (forceOrderHistory
          || this.lastOrderHistoryRefreshAt === 0
          || now - this.lastOrderHistoryRefreshAt >= this.orderHistoryRefreshMs);
      const [balanceResult, cancelableResult, orderHistoryResult] = await Promise.allSettled([
        this.paperService.getBalance(),
        this.paperClient?.getCancelableOrders?.() ?? Promise.resolve([]),
        shouldRefreshOrderHistory
          ? this.paperClient.getDailyOrders()
          : Promise.resolve(null),
      ]);
      if (balanceResult.status === "rejected") throw balanceResult.reason;
      this.balance = balanceResult.value;
      this.cancelableOrders = cancelableResult.status === "fulfilled"
        ? cancelableResult.value
        : this.cancelableOrders;
      if (shouldRefreshOrderHistory) {
        if (orderHistoryResult.status === "fulfilled") {
          this.orderHistory = orderHistoryResult.value;
          this.lastOrderHistoryRefreshAt = Number(orderHistoryResult.value?.fetchedAt) || this.now();
          this.orderHistoryError = null;
        } else {
          this.orderHistoryError = safeError(
            orderHistoryResult.reason,
            "KIS_ORDER_HISTORY_REFRESH_FAILED",
          );
        }
      }
      this.lastAccountRefreshAt = this.now();
      this.accountError = cancelableResult.status === "rejected"
        ? safeError(cancelableResult.reason, "KIS_CANCELABLE_ORDERS_REFRESH_FAILED")
        : null;
      this.emitSnapshot();
      return this.snapshot();
    } catch (error) {
      this.accountError = safeError(error, "KIS_PAPER_BALANCE_REFRESH_FAILED");
      this.emitSnapshot();
      return this.snapshot();
    }
  }

  async submitOrder(input) {
    if (!this.paperService) throw disabledPaperError();
    const type = String(input?.type ?? "MARKET").trim().toUpperCase();
    const request = {
      ...input,
      symbol: this.selection.symbol,
      type,
      referencePrice: type === "MARKET"
        ? positiveNumberOr(input?.referencePrice, this.snapshot().lastPrice)
        : input?.referencePrice,
    };
    const result = await this.paperService.submitOrder(request);
    await this.refreshAccount({ forceOrderHistory: true });
    return result;
  }

  async reviseOrder(input) {
    if (!this.paperService) throw disabledPaperError();
    const result = await this.paperService.reviseOrder(input);
    await this.refreshAccount({ forceOrderHistory: true });
    return result;
  }

  async cancelOrder(input) {
    if (!this.paperService) throw disabledPaperError();
    const result = await this.paperService.cancelOrder(input);
    await this.refreshAccount({ forceOrderHistory: true });
    return result;
  }

  setKillSwitch(enabled) {
    if (!this.paperService) throw disabledPaperError();
    const status = this.paperService.setKillSwitch(enabled);
    this.emitSnapshot();
    return status;
  }

  refreshDue() {
    const now = this.now();
    if (now - this.lastMarketRefreshAt >= this.marketRefreshMs) void this.refreshMarket();
    if (now - this.lastAccountRefreshAt >= this.accountRefreshMs) void this.refreshAccount();
  }

  watchSelection() {
    try {
      this.realtimeClient?.watchSymbols?.([{
        symbol: this.selection.symbol,
        venue: realtimeVenue(this.selection.market),
      }]);
    } catch (error) {
      this.marketError = safeError(error, "KIS_REALTIME_WATCH_FAILED");
    }
  }

  bindRealtime() {
    if (!this.realtimeClient || typeof this.realtimeClient.on !== "function") return;
    const onMarketData = (snapshot) => {
      if (snapshot?.symbol !== this.selection.symbol) return;
      this.realtimeSnapshot = snapshot;
      this.captureTrade(snapshot.trade, snapshot.orderBook);
      this.emitSnapshot();
    };
    const onStatus = () => this.emitSnapshot();
    const onError = (error) => {
      this.marketError = safeError(error, "KIS_REALTIME_ERROR");
      this.emitSnapshot();
    };
    this.realtimeClient.on("marketData", onMarketData);
    this.realtimeClient.on("status", onStatus);
    this.realtimeClient.on("errorState", onError);
    this.listeners = { onMarketData, onStatus, onError };
  }

  unbindRealtime() {
    if (!this.listeners || typeof this.realtimeClient?.off !== "function") return;
    this.realtimeClient.off("marketData", this.listeners.onMarketData);
    this.realtimeClient.off("status", this.listeners.onStatus);
    this.realtimeClient.off("errorState", this.listeners.onError);
    this.listeners = null;
  }

  captureTrade(trade, orderBook) {
    const price = Number(trade?.currentPrice);
    const size = Number(trade?.tradeVolume);
    const timestamp = Number(trade?.receivedAt);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size <= 0
      || !Number.isFinite(timestamp)) return;
    const key = `${trade.businessDate ?? ""}:${trade.tradeTime ?? ""}:${price}:${size}:${timestamp}`;
    if (this.trades.at(-1)?.key === key) return;
    const previous = this.trades.at(-1);
    const side = classifyTrade({ price, orderBook, previous });
    this.trades.push({ key, timestamp, price, size, side });
    if (this.trades.length > 600) this.trades.splice(0, this.trades.length - 600);
    this.upsertRealtimeCandle({ trade, price, size, timestamp });
  }

  upsertRealtimeCandle({ trade, price, size, timestamp }) {
    const key = minuteKey(trade?.businessDate, trade?.tradeTime, timestamp);
    const existing = this.candles.findLast?.((item) => item.key === key)
      ?? [...this.candles].reverse().find((item) => item.key === key);
    if (existing) {
      existing.high = Math.max(existing.high, price);
      existing.low = Math.min(existing.low, price);
      existing.close = price;
      existing.volume += size;
      existing.timestamp = timestamp;
      return;
    }
    this.candles.push({
      key,
      timestamp,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: size,
    });
    this.candles.sort((a, b) => a.timestamp - b.timestamp);
    if (this.candles.length > 240) this.candles.splice(0, this.candles.length - 240);
  }

  emitSnapshot() {
    this.emit("snapshot", this.snapshot());
  }
}

function mapPaperAccount({
  balance,
  symbol,
  cancelableOrders,
  orderHistory,
  paperEnabled,
  accountError,
  orderHistoryError,
}) {
  const positions = Array.isArray(balance?.positions) ? balance.positions : [];
  const position = positions.find((item) => item.symbol === symbol) ?? null;
  const cancelable = Array.isArray(cancelableOrders) ? cancelableOrders : [];
  const orders = Array.isArray(orderHistory?.orders) ? orderHistory.orders : [];
  const reservedCash = cancelable
    .filter((order) => order.side === "BUY")
    .reduce((sum, order) => sum + (Number(order.orderPrice) || 0) * (Number(order.cancelableQuantity) || 0), 0);
  const reservedSellQuantity = cancelable
    .filter((order) => order.side === "SELL" && order.symbol === symbol)
    .reduce((sum, order) => sum + (Number(order.cancelableQuantity) || 0), 0);
  return {
    source: "KIS",
    mode: "PAPER_TRADING",
    available: paperEnabled && Boolean(balance),
    error: accountError,
    orderHistoryError,
    equity: nullableNumber(balance?.summary?.totalEvaluationAmount),
    availableCash: nullableNumber(balance?.summary?.cash),
    reservedCash,
    position: {
      quantity: Number(position?.quantity) || 0,
      averagePrice: nullableNumber(position?.averagePrice),
      currentPrice: nullableNumber(position?.currentPrice),
      evaluationAmount: nullableNumber(position?.evaluationAmount),
      evaluationProfitLossRate: nullableNumber(position?.evaluationProfitLossRate),
    },
    sellableQuantity: Number(position?.orderableQuantity) || 0,
    unrealizedPnl: nullableNumber(position?.evaluationProfitLoss),
    realizedPnl: null,
    purchaseAmount: nullableNumber(balance?.summary?.purchaseAmount),
    evaluationAmount: nullableNumber(balance?.summary?.evaluationAmount),
    assetChangeAmount: nullableNumber(balance?.summary?.assetChangeAmount),
    assetChangeRate: nullableNumber(balance?.summary?.assetChangeRate),
    openOrderCount: cancelable.length,
    reservedSellQuantity,
    cancelableOrders: structuredClone(cancelable),
    positions: structuredClone(positions),
    orders: structuredClone(orders),
    orderHistorySummary: orderHistory?.summary ? structuredClone(orderHistory.summary) : null,
    orderHistoryFetchedAt: finiteNumberOr(orderHistory?.fetchedAt, null),
    fetchedAt: balance?.fetchedAt ?? null,
  };
}

function mapPaperCommands(service, limit = 30) {
  const states = service?.commands instanceof Map ? [...service.commands.values()] : [];
  return states
    .sort((left, right) => (Number(right?.timestamp) || 0) - (Number(left?.timestamp) || 0))
    .slice(0, limit)
    .map((state) => ({
      id: String(state?.clientOrderId ?? state?.commandId ?? ""),
      at: finiteNumberOr(state?.timestamp, null),
      operation: String(state?.operation ?? "SUBMIT"),
      request: structuredClone(state?.request ?? {}),
      response: state?.result
        ? structuredClone(state.result)
        : {
          clientOrderId: state?.clientOrderId ?? null,
          operation: state?.operation ?? null,
          status: state?.state === "PENDING" ? "PENDING" : "ERROR",
          replayed: false,
          ...(state?.error ? { error: structuredClone(state.error) } : {}),
        },
    }));
}

function normalizeSelection(input, selectedAt) {
  const symbol = String(input?.symbol ?? "").trim().toUpperCase();
  const symbolName = String(input?.symbolName ?? input?.name ?? "").trim();
  if (!/^(?:\d{6}|Q\d{6})$/.test(symbol) || !symbolName) {
    throw new TypeError("유효한 KIS 선택 종목 정보가 필요합니다.");
  }
  const initialPrice = positiveNumberOr(input?.initialPrice, 1);
  return {
    symbol,
    symbolName,
    market: optionalText(input?.market),
    securityType: optionalText(input?.securityType),
    initialPrice,
    previousClose: positiveNumberOr(input?.previousClose, initialPrice),
    tickSize: positiveNumberOr(input?.tickSize, 1),
    quoteFetchedAt: finiteNumberOr(input?.quoteFetchedAt, null),
    selectedAt: finiteNumberOr(input?.selectedAt, selectedAt),
  };
}

function selectionQuote(selection, fetchedAt) {
  return {
    source: selection.initialPrice > 1 ? "SELECTED_INSTRUMENT_CACHE" : "KIS_NOT_CONNECTED",
    currentPrice: selection.initialPrice,
    basePrice: selection.previousClose,
    askUnit: selection.tickSize,
    changePercent: percentageChange(selection.initialPrice, selection.previousClose),
    fetchedAt: selection.quoteFetchedAt ?? fetchedAt,
  };
}

function normalizeLimits(input) {
  return {
    maxOrderQuantity: positiveIntegerOr(input?.maxOrderQuantity, 1),
    maxOrderValue: positiveIntegerOr(input?.maxOrderValue, 0),
    maxDailyOrders: positiveIntegerOr(input?.maxDailyOrders, 0),
    maxDailyLoss: positiveIntegerOr(input?.maxDailyLoss, 0),
  };
}

function normalizeBook(input) {
  return {
    asks: normalizeLevels(input?.asks),
    bids: normalizeLevels(input?.bids),
  };
}

function emptyBook() {
  return { asks: [], bids: [], fetchedAt: null };
}

function validBook(input) {
  return Array.isArray(input?.asks) && input.asks.length > 0
    && Array.isArray(input?.bids) && input.bids.length > 0;
}

function normalizeLevels(levels) {
  if (!Array.isArray(levels)) return [];
  return levels.map((level) => ({
    price: Number(level?.price),
    size: Number(level?.size),
  })).filter((level) => Number.isFinite(level.price) && level.price > 0
    && Number.isFinite(level.size) && level.size >= 0);
}

function normalizeMinuteBars(bars, fetchedAt) {
  if (!Array.isArray(bars)) return [];
  const today = koreaDateParts(fetchedAt);
  return bars.map((bar) => {
    const timestamp = koreaTimestamp(today, bar.time, fetchedAt);
    return {
      key: `${today.date}:${String(bar.time ?? "").slice(0, 4)}`,
      timestamp,
      open: Number(bar.open),
      high: Number(bar.high),
      low: Number(bar.low),
      close: Number(bar.close),
      volume: Number(bar.volume) || 0,
    };
  }).filter((bar) => [bar.open, bar.high, bar.low, bar.close, bar.timestamp]
    .every((value) => Number.isFinite(value) && value > 0))
    .sort((a, b) => a.timestamp - b.timestamp);
}

function classifyTrade({ price, orderBook, previous }) {
  const bestAsk = Number(orderBook?.bestAsk ?? orderBook?.asks?.[0]?.price);
  const bestBid = Number(orderBook?.bestBid ?? orderBook?.bids?.[0]?.price);
  if (Number.isFinite(bestAsk) && price >= bestAsk) return "BUY";
  if (Number.isFinite(bestBid) && price <= bestBid) return "SELL";
  if (previous && price > previous.price) return "BUY";
  if (previous && price < previous.price) return "SELL";
  return previous?.side ?? "BUY";
}

function realtimeVenue(market) {
  const value = String(market ?? "").trim().toUpperCase();
  if (value === "NXT" || value === "NX") return "NXT";
  if (value === "UN" || value === "UNIFIED" || value === "INTEGRATED") return "UNIFIED";
  return "KRX";
}

function minuteKey(businessDate, tradeTime, fallback) {
  const date = String(businessDate ?? "").replace(/\D/g, "").slice(0, 8);
  const time = String(tradeTime ?? "").replace(/\D/g, "").padStart(6, "0").slice(0, 4);
  return date && time ? `${date}:${time}` : `fallback:${Math.floor(fallback / 60_000)}`;
}

function koreaDateParts(timestamp) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${value.year}${value.month}${value.day}`,
    year: Number(value.year),
    month: Number(value.month),
    day: Number(value.day),
  };
}

function koreaTimestamp(today, rawTime, fallback) {
  const digits = String(rawTime ?? "").replace(/\D/g, "").padStart(6, "0");
  if (!/^\d{6}$/.test(digits)) return fallback;
  const hour = Number(digits.slice(0, 2));
  const minute = Number(digits.slice(2, 4));
  const second = Number(digits.slice(4, 6));
  if (hour > 23 || minute > 59 || second > 59) return fallback;
  return Date.UTC(today.year, today.month - 1, today.day, hour - 9, minute, second);
}

function percentageChange(current, previous) {
  return previous > 0 ? ((current - previous) / previous) * 100 : 0;
}

function optionalText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new TypeError(`${label}는 양의 정수여야 합니다.`);
  return number;
}

function positiveIntegerOr(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function positiveNumberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function finiteNumberOr(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeError(error, fallbackCode) {
  return {
    code: typeof error?.code === "string" ? error.code : fallbackCode,
    message: error instanceof Error ? error.message : String(error ?? "KIS 연결 오류"),
  };
}

function disabledPaperError() {
  const error = new Error("한국투자 모의투자 주문 모드가 비활성화되어 있습니다.");
  error.code = "KIS_PAPER_DISABLED";
  error.statusCode = 503;
  return error;
}
