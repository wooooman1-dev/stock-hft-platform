import test from "node:test";
import assert from "node:assert/strict";
import { calculateMicrostructureMetrics } from "../domain/analysis.js";

const now = 1_000_000;

test("near-book and aggressive trades create a buy signal", () => {
  const metrics = calculateMicrostructureMetrics({
    now,
    tickSize: 100,
    book: {
      bids: [{ price: 69_900, size: 2_000 }, { price: 69_800, size: 1_600 }],
      asks: [{ price: 70_000, size: 250 }, { price: 70_100, size: 300 }],
    },
    trades: [
      { id: "1", timestamp: now - 1_000, price: 69_900, size: 20, side: "BUY" },
      { id: "2", timestamp: now - 500, price: 70_000, size: 80, side: "BUY" },
      { id: "3", timestamp: now - 100, price: 70_100, size: 90, side: "BUY" },
    ],
  });
  assert.equal(metrics.signal, "BUY");
  assert.ok(metrics.score >= 35);
});

test("wide spread reduces a positive signal score", () => {
  const input = {
    now,
    tickSize: 100,
    trades: [{ id: "1", timestamp: now - 100, price: 70_000, size: 50, side: "BUY" }],
  };
  const narrow = calculateMicrostructureMetrics({ ...input, book: { bids: [{ price: 69_900, size: 1_000 }], asks: [{ price: 70_000, size: 200 }] } });
  const wide = calculateMicrostructureMetrics({ ...input, book: { bids: [{ price: 69_700, size: 1_000 }], asks: [{ price: 70_000, size: 200 }] } });
  assert.ok(wide.score < narrow.score);
});
