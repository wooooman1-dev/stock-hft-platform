import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { MarketRuntime } from "../domain/runtime.js";

class FakeSource extends EventEmitter {
  constructor() {
    super();
    this.mode = "LS_PAPER";
    this.provider = "LS_SECURITIES";
    this.tickSize = 100;
    this.connected = false;
  }
  async start() { this.connected = true; this.emit("status", { connected: true }); }
  stop() { this.connected = false; }
}

test("runtime accepts an event-driven broker market source", async () => {
  const source = new FakeSource();
  const runtime = new MarketRuntime("005930", "삼성전자", 70_000, { marketSource: source });
  await runtime.start();
  source.emit("tick", {
    timestamp: 1_000,
    lastPrice: 72_100,
    previousClose: 70_000,
    book: { asks: [{ price: 72_200, size: 100 }], bids: [{ price: 72_000, size: 100 }] },
    trades: [{ id: "t1", timestamp: 1_000, price: 72_100, size: 10, side: "BUY" }],
    candles: [{ time: 1_000, open: 72_100, high: 72_100, low: 72_100, close: 72_100, volume: 10 }],
  });
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.lastPrice, 72_100);
  assert.equal(snapshot.previousClose, 70_000);
  assert.equal(Number(snapshot.changePercent.toFixed(2)), 3);
  assert.equal(snapshot.system.mode, "LS_PAPER");
  assert.equal(snapshot.system.provider, "LS_SECURITIES");
  assert.equal(snapshot.system.feedConnected, true);
  runtime.stop();
});

test("runtime rejects orders when the market feed is disconnected", () => {
  const source = new FakeSource();
  const runtime = new MarketRuntime("005930", "삼성전자", 70_000, {
    marketSource: source,
    now: () => 1_000,
  });
  const order = runtime.submitOrder("BUY", 1);
  assert.equal(order.status, "REJECTED");
  assert.match(order.reason, /시세 연결/);
  runtime.stop();
});

test("runtime rejects orders when the latest market event is stale", async () => {
  const source = new FakeSource();
  let now = 1_000;
  const runtime = new MarketRuntime("005930", "삼성전자", 70_000, {
    marketSource: source,
    now: () => now,
    maxMarketDataAgeMs: 5_000,
  });
  await runtime.start();
  source.emit("tick", {
    timestamp: 1_000,
    lastPrice: 72_100,
    book: { asks: [{ price: 72_200, size: 100 }], bids: [{ price: 72_000, size: 100 }] },
    trades: [],
    candles: [],
  });
  now = 7_001;
  const order = runtime.submitOrder("BUY", 1);
  assert.equal(order.status, "REJECTED");
  assert.match(order.reason, /지연/);
  runtime.stop();
});
