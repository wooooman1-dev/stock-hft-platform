import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { KisMainWorkspace } from "../domain/kisMainWorkspace.js";
import { KisRealtimeSubscriptionCoordinator } from "../integrations/kis/kisRealtimeSubscriptionCoordinator.js";

class FakeRealtime extends EventEmitter {
  constructor() {
    super();
    this.items = [];
    this.state = "CONNECTED";
  }
  status() { return { state: this.state, connected: true, maxSymbols: 4, freshestDataAgeMs: 12 }; }
  snapshot(symbol) { return { symbol, connected: true, orderBook: null, trade: null }; }
  watchSymbols(items) { this.items = structuredClone(items); return this.status(); }
  start() { return this.status(); }
  stop() { this.state = "STOPPED"; }
}

const selection = {
  symbol: "005930",
  symbolName: "삼성전자",
  market: "KOSPI",
  securityType: "주식",
  initialPrice: 70_000,
  previousClose: 69_000,
  tickSize: 100,
};

function clients(now) {
  const realtime = new FakeRealtime();
  const quoteClient = {
    async getCurrentPrice() {
      return {
        source: "KIS",
        currentPrice: 240_000,
        basePrice: 238_000,
        askUnit: 100,
        changePercent: 0.84,
        fetchedAt: now(),
      };
    },
  };
  const marketDataClient = {
    async getOrderBook() {
      return {
        asks: [{ price: 240_100, size: 100 }, { price: 240_200, size: 80 }],
        bids: [{ price: 240_000, size: 140 }, { price: 239_900, size: 90 }],
        fetchedAt: now(),
      };
    },
    async getMinuteBars() {
      return [
        { time: "153000", open: 239_000, high: 239_500, low: 238_900, close: 239_400, volume: 1000 },
        { time: "153100", open: 239_400, high: 240_100, low: 239_300, close: 240_000, volume: 1200 },
      ];
    },
  };
  const restoredCommand = {
    commandId: "command-1",
    clientOrderId: "manual-buy-005930-20260803-145408-01",
    operation: "SUBMIT",
    request: {
      side: "BUY",
      symbol: "005930",
      type: "MARKET",
      quantity: 1,
      referencePrice: 240_000,
      exchange: "KRX",
    },
    timestamp: Date.parse("2026-08-03T05:54:10Z"),
    day: "2026-08-03",
    state: "RESULT",
    result: {
      clientOrderId: "manual-buy-005930-20260803-145408-01",
      operation: "SUBMIT",
      status: "ACCEPTED",
      replayed: false,
      result: {
        orderNumber: "0000035986",
        orderOrganizationNumber: "00950",
      },
    },
    error: null,
  };
  const paperService = {
    submitted: null,
    commands: new Map([[restoredCommand.clientOrderId, restoredCommand]]),
    status() { return { killSwitch: false, unknownResult: false, automaticStrategyConnected: false }; },
    async getBalance() {
      return {
        fetchedAt: now(),
        positions: [{
          symbol: "005930",
          quantity: 2,
          orderableQuantity: 2,
          averagePrice: 240_500,
          currentPrice: 240_000,
          evaluationAmount: 480_000,
          evaluationProfitLoss: -1_000,
          evaluationProfitLossRate: -0.21,
        }],
        summary: {
          cash: 9_500_000,
          purchaseAmount: 481_000,
          evaluationAmount: 480_000,
          totalEvaluationAmount: 9_999_000,
          assetChangeAmount: -1_000,
          assetChangeRate: -0.01,
        },
      };
    },
    async submitOrder(input) {
      this.submitted = structuredClone(input);
      return { status: "ACCEPTED", result: { orderNumber: "123", orderOrganizationNumber: "00950" } };
    },
    async reviseOrder(input) { return { status: "ACCEPTED", input }; },
    async cancelOrder(input) { return { status: "ACCEPTED", input }; },
    setKillSwitch(enabled) { return { killSwitch: enabled }; },
  };
  const paperClient = {
    async getCancelableOrders() {
      return [{
        orderNumber: "123",
        orderOrganizationNumber: "00950",
        symbol: "005930",
        side: "SELL",
        cancelableQuantity: 1,
        orderPrice: 240_000,
      }];
    },
  };
  return { realtime, quoteClient, marketDataClient, paperService, paperClient };
}

test("main workspace maps KIS market and paper values into the existing dashboard snapshot", async () => {
  let clock = Date.parse("2026-08-03T06:32:00Z");
  const now = () => ++clock;
  const fake = clients(now);
  const workspace = new KisMainWorkspace({
    selection,
    quoteClient: fake.quoteClient,
    marketDataClient: fake.marketDataClient,
    realtimeClient: fake.realtime,
    paperService: fake.paperService,
    paperClient: fake.paperClient,
    paperLimits: { maxOrderQuantity: 10, maxOrderValue: 3_000_000, maxDailyOrders: 20, maxDailyLoss: 100_000 },
    now,
  });
  workspace.start();
  await workspace.refreshAll();
  const snapshot = workspace.snapshot();
  assert.equal(snapshot.instrument.simulation, false);
  assert.equal(snapshot.instrument.priceSource, "KIS_PROD_READ_ONLY");
  assert.equal(snapshot.lastPrice, 240_000);
  assert.equal(snapshot.book.asks[0].price, 240_100);
  assert.equal(snapshot.candles.length, 2);
  assert.equal(snapshot.account.equity, 9_999_000);
  assert.equal(snapshot.account.position.quantity, 2);
  assert.equal(snapshot.account.openOrderCount, 1);
  assert.equal(snapshot.account.commands.length, 1);
  assert.equal(snapshot.account.commands[0].request.side, "BUY");
  assert.equal(snapshot.account.commands[0].response.status, "ACCEPTED");
  assert.equal(snapshot.account.commands[0].response.result.orderNumber, "0000035986");
  assert.equal(snapshot.system.autoPaperTrading, false);
  assert.equal(snapshot.system.automaticStrategyConnected, false);
  assert.deepEqual(fake.realtime.items, [{ symbol: "005930", venue: "KRX" }]);
  workspace.stop();
});

test("KIS realtime order book and trades replace REST fallback values", async () => {
  let clock = Date.parse("2026-08-03T06:32:00Z");
  const now = () => ++clock;
  const fake = clients(now);
  const workspace = new KisMainWorkspace({
    selection,
    quoteClient: fake.quoteClient,
    marketDataClient: fake.marketDataClient,
    realtimeClient: fake.realtime,
    now,
  });
  await workspace.refreshMarket();
  const receivedAt = now();
  fake.realtime.emit("marketData", {
    symbol: "005930",
    connected: true,
    stale: false,
    latestAt: receivedAt,
    orderBook: {
      bestAsk: 240_200,
      bestBid: 240_100,
      asks: [{ price: 240_200, size: 50 }],
      bids: [{ price: 240_100, size: 200 }],
      receivedAt,
    },
    trade: {
      businessDate: "20260803",
      tradeTime: "153201",
      currentPrice: 240_200,
      tradeVolume: 5,
      changePercent: 0.92,
      receivedAt,
    },
  });
  const snapshot = workspace.snapshot();
  assert.equal(snapshot.lastPrice, 240_200);
  assert.equal(snapshot.book.asks[0].price, 240_200);
  assert.equal(snapshot.trades.length, 1);
  assert.equal(snapshot.trades[0].side, "BUY");
  assert.equal(snapshot.system.marketDataSource, "KIS_WEBSOCKET");
});

test("main KIS order supplies selected symbol and market reference price", async () => {
  let clock = Date.parse("2026-08-03T06:32:00Z");
  const now = () => ++clock;
  const fake = clients(now);
  const workspace = new KisMainWorkspace({
    selection,
    quoteClient: fake.quoteClient,
    marketDataClient: fake.marketDataClient,
    paperService: fake.paperService,
    paperClient: fake.paperClient,
    now,
  });
  await workspace.refreshMarket();
  const result = await workspace.submitOrder({
    clientOrderId: "ui-buy-1",
    side: "BUY",
    type: "MARKET",
    quantity: 1,
    exchange: "KRX",
  });
  assert.equal(result.status, "ACCEPTED");
  assert.equal(fake.paperService.submitted.symbol, "005930");
  assert.equal(fake.paperService.submitted.referencePrice, 240_000);
});

test("realtime coordinator keeps the main symbol while sharing one KIS socket", () => {
  const client = new FakeRealtime();
  const coordinator = new KisRealtimeSubscriptionCoordinator(client);
  const scanner = coordinator.createView("scanner", { priority: 10 });
  const main = coordinator.createView("main", { priority: 100 });
  scanner.watchSymbols([
    { symbol: "000660", venue: "KRX" },
    { symbol: "035420", venue: "KRX" },
  ]);
  main.watchSymbols([{ symbol: "005930", venue: "KRX" }]);
  assert.deepEqual(client.items.map((item) => item.symbol), ["005930", "000660", "035420"]);
  scanner.stop();
  assert.deepEqual(client.items.map((item) => item.symbol), ["005930"]);
});