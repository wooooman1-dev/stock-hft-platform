import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { LsMainRealtimeClient } from "../brokers/ls/lsMainRealtimeClient.js";
import { KisMainWorkspace } from "../domain/kisMainWorkspace.js";
import { createMainLsRealtimeClient, resolveMainMarketDataProvider } from "../market/createMarketDataSource.js";

class FakeLsRealtime extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.subscriptions = [];
    this.unsubscriptions = [];
    this.connectCalls = 0;
    this.failConnect = false;
  }
  async connect() {
    this.connectCalls += 1;
    if (this.failConnect) throw new Error("connect failed");
    this.connected = true;
    this.emit("status", { connected: true, state: "connected" });
  }
  subscribe(item) { this.subscriptions.push(item); }
  unsubscribe(item) { this.unsubscriptions.push(item); }
  close() { this.connected = false; }
}

function fakeRest({ lastPrice = 70_000, previousClose = 69_000 } = {}) {
  return {
    calls: [],
    async getCurrentOrderBook(symbol) {
      this.calls.push(symbol);
      return {
        timestamp: 1_000,
        lastPrice,
        previousClose,
        book: {
          asks: [{ price: 70_100, size: 10 }, { price: 70_200, size: 20 }],
          bids: [{ price: 70_000, size: 30 }, { price: 69_900, size: 40 }],
        },
      };
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("LS main client subscribes market-specific TR codes and emits KIS-shaped snapshots", async () => {
  const realtime = new FakeLsRealtime();
  const rest = fakeRest();
  let now = 1_000;
  const client = new LsMainRealtimeClient({ restClient: rest, realtimeClient: realtime, now: () => now });
  const events = [];
  client.on("marketData", (snapshot) => events.push(snapshot));

  client.watchSymbols([{ symbol: "035720", venue: "KRX", market: "KOSDAQ" }]);
  await flush();

  assert.deepEqual(realtime.subscriptions, [
    { trCode: "HA_", symbol: "035720" },
    { trCode: "K3_", symbol: "035720" },
  ]);
  assert.equal(realtime.connectCalls, 1);
  assert.equal(client.status().connected, true);
  assert.deepEqual(rest.calls, ["035720"]);
  const initial = events.at(-1);
  assert.equal(initial.symbol, "035720");
  assert.equal(initial.previousClose, 69_000);
  assert.equal(initial.orderBook.bestAsk, 70_100);
  assert.equal(initial.trade.currentPrice, 70_000);

  now = 2_000;
  realtime.emit("trade", { symbol: "035720", timestamp: 2_000, price: 70_100, size: 5, side: "BUY", exchangeTime: "093001" });
  const tradeSnapshot = events.at(-1);
  assert.equal(tradeSnapshot.trade.currentPrice, 70_100);
  assert.equal(tradeSnapshot.trade.tradeVolume, 5);
  assert.equal(tradeSnapshot.trade.tradeTime, "093001");
  assert.equal(Number(tradeSnapshot.trade.changePercent.toFixed(2)), 1.59);
  assert.equal(tradeSnapshot.stale, false);

  realtime.emit("trade", { symbol: "005930", timestamp: 2_100, price: 1, size: 1, side: "BUY" });
  assert.equal(events.at(-1).trade.currentPrice, 70_100, "다른 종목 체결은 무시한다");
  client.stop();
});

test("LS main client switches symbols by unsubscribing the previous TR codes", async () => {
  const realtime = new FakeLsRealtime();
  const client = new LsMainRealtimeClient({ restClient: fakeRest(), realtimeClient: realtime, now: () => 1_000 });
  client.watchSymbols([{ symbol: "005930", market: "KOSPI" }]);
  client.watchSymbols([{ symbol: "000660", market: "KOSPI" }]);
  await flush();
  assert.deepEqual(realtime.unsubscriptions, [
    { trCode: "H1_", symbol: "005930" },
    { trCode: "S3_", symbol: "005930" },
  ]);
  assert.deepEqual(realtime.subscriptions.at(-1), { trCode: "S3_", symbol: "000660" });
  client.stop();
});

test("LS main client rejects ETN codes it cannot quote and reports an error state", () => {
  const realtime = new FakeLsRealtime();
  const client = new LsMainRealtimeClient({ restClient: fakeRest(), realtimeClient: realtime, now: () => 1_000 });
  const errors = [];
  client.on("errorState", (error) => errors.push(error));
  client.watchSymbols([{ symbol: "Q500001" }]);
  assert.equal(realtime.subscriptions.length, 0);
  assert.equal(errors[0].code, "LS_UNSUPPORTED_SYMBOL");
  client.stop();
});

test("LS main client schedules a reconnect when the connection fails", async () => {
  const realtime = new FakeLsRealtime();
  realtime.failConnect = true;
  const timers = [];
  const client = new LsMainRealtimeClient({
    restClient: fakeRest(),
    realtimeClient: realtime,
    now: () => 1_000,
    setTimeoutImpl: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    clearTimeoutImpl: () => {},
  });
  client.watchSymbols([{ symbol: "005930" }]);
  await flush();
  assert.equal(client.status().state, "DISCONNECTED");
  assert.equal(client.status().lastError.code, "LS_REALTIME_CONNECT_FAILED");
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 2_000);

  realtime.failConnect = false;
  timers[0].fn();
  await flush();
  assert.equal(client.status().connected, true);
  assert.equal(client.status().reconnectAttempt, 0);
  client.stop();
});

test("main workspace renders LS realtime data without KIS REST clients", async () => {
  const realtime = new FakeLsRealtime();
  let now = 1_000;
  const client = new LsMainRealtimeClient({ restClient: fakeRest(), realtimeClient: realtime, now: () => now });
  const workspace = new KisMainWorkspace({
    selection: {
      symbol: "005930",
      symbolName: "삼성전자",
      market: "KOSPI",
      initialPrice: 68_000,
      previousClose: 67_000,
      tickSize: 100,
    },
    realtimeClient: client,
    marketDataProvider: "LS",
    now: () => now,
  });
  workspace.start();
  await flush();
  now = 1_500;
  realtime.emit("trade", { symbol: "005930", timestamp: 1_500, price: 70_100, size: 3, side: "BUY", exchangeTime: "093000" });

  const snapshot = workspace.snapshot();
  assert.equal(snapshot.system.marketDataProvider, "LS");
  assert.equal(snapshot.system.mode, "LS_PAPER_DATA");
  assert.equal(snapshot.system.marketDataSource, "LS_WEBSOCKET");
  assert.equal(snapshot.system.feedConnected, true);
  assert.equal(snapshot.system.marketError, null, "LS 모드에서는 KIS REST 비활성 오류를 띄우지 않는다");
  assert.equal(snapshot.instrument.priceSource, "LS_PAPER_DATA");
  assert.equal(snapshot.lastPrice, 70_100);
  assert.equal(snapshot.previousClose, 69_000);
  assert.equal(snapshot.book.asks[0].price, 70_100);
  assert.equal(snapshot.trades[0].price, 70_100);

  realtime.emit("error", new Error("LS 실시간 메시지 처리 오류"));
  assert.equal(workspace.snapshot().system.marketError.message, "LS 실시간 메시지 처리 오류");
  realtime.emit("trade", { symbol: "005930", timestamp: 1_600, price: 70_200, size: 1, side: "BUY", exchangeTime: "093001" });
  assert.equal(workspace.snapshot().system.marketError, null, "새 LS 시세가 오면 지난 오류를 내린다");
  workspace.stop();
  client.stop();
});

test("MARKET_MODE=ls selects LS for the main screen; anything else keeps KIS", () => {
  assert.equal(resolveMainMarketDataProvider({ MARKET_MODE: "ls" }), "LS");
  assert.equal(resolveMainMarketDataProvider({ MARKET_MODE: "simulation" }), "KIS");
  assert.equal(resolveMainMarketDataProvider({}), "KIS");
  assert.equal(createMainLsRealtimeClient({ env: {} }), null);
  const client = createMainLsRealtimeClient({
    env: { MARKET_MODE: "ls", LS_ENVIRONMENT: "live", LS_APP_KEY: "k", LS_APP_SECRET: "s" },
  });
  assert.ok(client instanceof LsMainRealtimeClient);
  assert.equal(client.status().mode, "LS_LIVE_DATA");
  assert.throws(() => createMainLsRealtimeClient({ env: { MARKET_MODE: "ls", LS_ENVIRONMENT: "prod" } }), /LS_ENVIRONMENT/);
});
