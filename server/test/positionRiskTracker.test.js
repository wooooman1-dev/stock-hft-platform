import assert from "node:assert/strict";
import test from "node:test";
import { PositionRiskTracker } from "../domain/positionRiskTracker.js";

test("position risk tracker records one opening time and the highest observed price", () => {
  const tracker = new PositionRiskTracker();
  assert.deepEqual(tracker.snapshot(), {
    quantity: 0,
    openedAt: null,
    peakPrice: null,
    belowPeakSince: null,
  });

  assert.deepEqual(tracker.update({ quantity: 10, lastPrice: 70_000, timestamp: 1_000 }), {
    quantity: 10,
    openedAt: 1_000,
    peakPrice: 70_000,
    belowPeakSince: null,
  });
  assert.deepEqual(tracker.update({ quantity: 15, lastPrice: 71_000, timestamp: 2_000 }), {
    quantity: 15,
    openedAt: 1_000,
    peakPrice: 71_000,
    belowPeakSince: null,
  });
  assert.deepEqual(tracker.update({ quantity: 5, lastPrice: 70_500, timestamp: 3_000 }), {
    quantity: 5,
    openedAt: 1_000,
    peakPrice: 71_000,
    belowPeakSince: 3_000,
  });
});

test("position risk tracker resets only when the position becomes flat", () => {
  const tracker = new PositionRiskTracker();
  tracker.update({ quantity: 3, lastPrice: 70_000, timestamp: 1_000 });
  assert.deepEqual(tracker.update({ quantity: 0, lastPrice: 69_000, timestamp: 2_000 }), {
    quantity: 0,
    openedAt: null,
    peakPrice: null,
    belowPeakSince: null,
  });
  assert.deepEqual(tracker.update({ quantity: 2, lastPrice: 68_000, timestamp: 3_000 }), {
    quantity: 2,
    openedAt: 3_000,
    peakPrice: 68_000,
    belowPeakSince: null,
  });
});

// 2026-09-23: "잔고에서 처음 본 시각"이 아니라 "실제 매수 제출 시각"부터 30분을
// 세야 한다는 지적에 따라 openedAt을 넘길 수 있게 했다. null/undefined는
// "모른다"는 뜻이라 timestamp로 대체돼야 한다 — Number(null)이 0이 되는 함정에
// 걸려서 처음엔 openedAt이 조용히 0으로 깔리는 버그가 있었다(테스트로 잡음).
test("known openedAt (실제 매수 시각) overrides the first-seen timestamp", () => {
  const tracker = new PositionRiskTracker();
  const snapshot = tracker.update({ quantity: 5, lastPrice: 70_000, timestamp: 5_000, openedAt: 4_910 });
  assert.equal(snapshot.openedAt, 4_910, "알고 있는 실제 매수 시각을 써야 한다");
});

test("openedAt이 null/undefined면(모름) timestamp로 대체된다 — Number(null)===0 함정 회귀 테스트", () => {
  for (const missing of [null, undefined]) {
    const tracker = new PositionRiskTracker();
    const snapshot = tracker.update({ quantity: 5, lastPrice: 70_000, timestamp: 5_000, openedAt: missing });
    assert.equal(snapshot.openedAt, 5_000, `openedAt=${missing}이면 timestamp를 써야 한다(0이 되면 안 된다)`);
  }
});

// 2026-09-23: 5초 폴링 사이에도 실시간 틱으로 고점·하락지속시간을 갱신하기 위해
// observeTick을 추가했다 — "5초 사이 순간적인 진짜 고점을 놓친다"는 지적에 따른
// 변경. 수량은 안 건드리고(폴링만 수량을 바꿈) 고점/하락시각만 갱신한다.
test("observeTick은 신고점이면 고점을 갱신하고 하락지속시각을 지운다", () => {
  const tracker = new PositionRiskTracker();
  tracker.update({ quantity: 10, lastPrice: 70_000, timestamp: 1_000 });
  tracker.observeTick({ price: 70_100, timestamp: 1_200 });
  assert.deepEqual(tracker.snapshot(), {
    quantity: 10, openedAt: 1_000, peakPrice: 70_100, belowPeakSince: null,
  });
});

test("observeTick은 고점 밑으로 내려온 최초 시각만 기록하고 그 뒤로는 유지한다", () => {
  const tracker = new PositionRiskTracker();
  tracker.update({ quantity: 10, lastPrice: 70_000, timestamp: 1_000 });
  tracker.observeTick({ price: 69_900, timestamp: 1_200 });
  tracker.observeTick({ price: 69_800, timestamp: 1_400 });
  const snapshot = tracker.observeTick({ price: 69_950, timestamp: 1_600 });
  assert.equal(snapshot.peakPrice, 70_000);
  assert.equal(snapshot.belowPeakSince, 1_200, "최초로 밑돈 시각(1_200)을 계속 유지해야 한다");
});

test("observeTick은 포지션이 없으면(quantity===0) 아무것도 하지 않는다", () => {
  const tracker = new PositionRiskTracker();
  const snapshot = tracker.observeTick({ price: 70_000, timestamp: 1_000 });
  assert.deepEqual(snapshot, { quantity: 0, openedAt: null, peakPrice: null, belowPeakSince: null });
});

test("position risk tracker rejects invalid quantity, price, and time", () => {
  const tracker = new PositionRiskTracker();
  assert.throws(() => tracker.update({ quantity: -1, lastPrice: 70_000, timestamp: 1_000 }), /수량/);
  assert.throws(() => tracker.update({ quantity: 1, lastPrice: 0, timestamp: 1_000 }), /현재가격/);
  assert.throws(() => tracker.update({ quantity: 1, lastPrice: 70_000, timestamp: NaN }), /시각/);
});
