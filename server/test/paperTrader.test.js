import test from "node:test";
import assert from "node:assert/strict";
import { PaperTrader } from "../domain/paperTrader.js";

const base = { spread: 100, tickSize: 100, source: "MANUAL", killSwitch: false };

test("paper trader fills round-trip and calculates realized pnl", () => {
  const trader = new PaperTrader(10_000_000);
  const buy = trader.submit({ ...base, side: "BUY", quantity: 10, referencePrice: 70_000 });
  assert.equal(buy.status, "FILLED");
  assert.equal(trader.snapshot(70_000).position.quantity, 10);
  const sell = trader.submit({ ...base, side: "SELL", quantity: 10, referencePrice: 70_500 });
  assert.equal(sell.status, "FILLED");
  assert.ok(trader.snapshot(70_500).realizedPnl > 0);
});

test("kill switch rejects new orders", () => {
  const trader = new PaperTrader();
  const order = trader.submit({ ...base, side: "BUY", quantity: 1, referencePrice: 70_000, killSwitch: true });
  assert.equal(order.status, "REJECTED");
  assert.match(order.reason, /킬 스위치/);
});
