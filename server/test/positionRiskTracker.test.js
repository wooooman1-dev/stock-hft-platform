import assert from "node:assert/strict";
import test from "node:test";
import { PositionRiskTracker } from "../domain/positionRiskTracker.js";

test("position risk tracker records one opening time and the highest observed price", () => {
  const tracker = new PositionRiskTracker();
  assert.deepEqual(tracker.snapshot(), {
    quantity: 0,
    openedAt: null,
    peakPrice: null,
  });

  assert.deepEqual(tracker.update({ quantity: 10, lastPrice: 70_000, timestamp: 1_000 }), {
    quantity: 10,
    openedAt: 1_000,
    peakPrice: 70_000,
  });
  assert.deepEqual(tracker.update({ quantity: 15, lastPrice: 71_000, timestamp: 2_000 }), {
    quantity: 15,
    openedAt: 1_000,
    peakPrice: 71_000,
  });
  assert.deepEqual(tracker.update({ quantity: 5, lastPrice: 70_500, timestamp: 3_000 }), {
    quantity: 5,
    openedAt: 1_000,
    peakPrice: 71_000,
  });
});

test("position risk tracker resets only when the position becomes flat", () => {
  const tracker = new PositionRiskTracker();
  tracker.update({ quantity: 3, lastPrice: 70_000, timestamp: 1_000 });
  assert.deepEqual(tracker.update({ quantity: 0, lastPrice: 69_000, timestamp: 2_000 }), {
    quantity: 0,
    openedAt: null,
    peakPrice: null,
  });
  assert.deepEqual(tracker.update({ quantity: 2, lastPrice: 68_000, timestamp: 3_000 }), {
    quantity: 2,
    openedAt: 3_000,
    peakPrice: 68_000,
  });
});

test("position risk tracker rejects invalid quantity, price, and time", () => {
  const tracker = new PositionRiskTracker();
  assert.throws(() => tracker.update({ quantity: -1, lastPrice: 70_000, timestamp: 1_000 }), /수량/);
  assert.throws(() => tracker.update({ quantity: 1, lastPrice: 0, timestamp: 1_000 }), /현재가격/);
  assert.throws(() => tracker.update({ quantity: 1, lastPrice: 70_000, timestamp: NaN }), /시각/);
});
