import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { LsMarketDataSource } from "../brokers/ls/lsMarketDataSource.js";

class FakeRealtimeClient extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.subscriptions = [];
  }
  async connect() { this.connected = true; this.emit("status", { connected: true }); }
  subscribe(subscription) { this.subscriptions.push(subscription); }
  close() { this.connected = false; }
}

test("LS market source seeds from t1101 and subscribes to order book and trades", async () => {
  const realtimeClient = new FakeRealtimeClient();
  const restClient = {
    getCurrentOrderBook: async () => ({
      timestamp: 1_000,
      lastPrice: 72_100,
      book: {
        asks: [{ price: 72_200, size: 100 }],
        bids: [{ price: 72_000, size: 120 }],
      },
    }),
  };
  const source = new LsMarketDataSource({
    symbol: "005930",
    market: "KOSPI",
    restClient,
    realtimeClient,
    now: () => 2_000,
  });
  const ticks = [];
  source.on("tick", (tick) => ticks.push(tick));

  await source.start();
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].lastPrice, 72_100);
  assert.deepEqual(realtimeClient.subscriptions, [
    { trCode: "H1_", symbol: "005930" },
    { trCode: "S3_", symbol: "005930" },
  ]);

  realtimeClient.emit("trade", {
    symbol: "005930", timestamp: 2_000, price: 72_200, size: 5, side: "BUY", exchangeTime: "093001",
  });
  assert.equal(ticks.at(-1).lastPrice, 72_200);
  assert.equal(ticks.at(-1).trades.at(-1).side, "BUY");
  assert.equal(ticks.at(-1).candles.at(-1).close, 72_200);
});
