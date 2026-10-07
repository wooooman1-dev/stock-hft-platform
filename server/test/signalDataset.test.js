import test from "node:test";
import assert from "node:assert/strict";
import { createSignalDatasetBuilder } from "../domain/signalDataset.js";

const T0 = Date.parse("2026-10-07T01:00:00Z"); // 10:00 KST

const tick = (offsetSec, price, symbol = "005930") => JSON.stringify({
  type: "REALTIME_MARKET_DATA",
  timestamp: T0 + offsetSec * 1000,
  payload: { snapshot: { symbol, trade: { currentPrice: price } } },
});

const scan = (offsetSec, candidates) => JSON.stringify({
  type: "SCANNER_REFRESH", timestamp: T0 + offsetSec * 1000, payload: { candidates },
});

function candidate(overrides = {}) {
  return {
    symbol: "005930", currentPrice: 10_000, stage: "WATCH", candidateType: "PULLBACK", score: 70,
    changePercent: 2, price: { high: 10_050 },
    microstructure: { recentReturnBps: 12, vwapExtensionBps: 30 },
    realtime: { state: "WATCH", metrics: { currentPrice: 10_000, executionStrength: 120, spreadBps: 10 } },
    ...overrides,
  };
}

test("스냅샷 시점 가격 대비 이후 30초 간격 가격 경로를 bp로 붙인다", () => {
  const builder = createSignalDatasetBuilder({ pathMinutes: 2 });
  // 10:00:00부터 1초마다 10,000원에서 시작해 30초마다 10원(10bp)씩 오른다.
  for (let second = 0; second <= 130; second += 1) {
    builder.ingestLine(tick(second, 10_000 + Math.floor(second / 30) * 10));
  }
  builder.ingestLine(scan(0, [candidate()]));
  const rows = builder.finish();
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.kind, "SNAPSHOT");
  assert.equal(row.day, "2026-10-07");
  assert.equal(row.hhmm, "10:00");
  assert.equal(row.exStr, 120);
  assert.equal(row.nearHighBps, ((10_050 - 10_000) / 10_050) * 10_000);
  assert.deepEqual(row.path, [10, 20, 30, 40]);
});

test("같은 종목 스냅샷은 표본 간격 안에서 한 번만 쓰고, 틱이 없는 종목은 버린다", () => {
  const builder = createSignalDatasetBuilder({ pathMinutes: 1, sampleIntervalMs: 60_000 });
  for (let second = 0; second <= 200; second += 1) builder.ingestLine(tick(second, 10_000));
  builder.ingestLine(scan(0, [candidate()]));
  builder.ingestLine(scan(15, [candidate()]));
  builder.ingestLine(scan(70, [candidate()]));
  builder.ingestLine(scan(0, [candidate({ symbol: "000660" })]));
  const rows = builder.finish();
  assert.deepEqual(rows.map((row) => row.ts - T0), [0, 70_000]);
  assert.ok(rows.every((row) => row.symbol === "005930"), "틱이 없는 종목(000660)은 평가할 수 없어 빠진다");
});

test("ENTRY_READY 전환은 전환 시점 지표와 함께 별도 종류로 기록된다", () => {
  const builder = createSignalDatasetBuilder({ pathMinutes: 1 });
  for (let second = 0; second <= 100; second += 1) builder.ingestLine(tick(second, 10_000));
  builder.ingestLine(JSON.stringify({
    type: "REALTIME_STATE_TRANSITION", timestamp: T0 + 5_000,
    payload: {
      symbol: "005930", toState: "ENTRY_READY", candidateStage: "CONFIRMATION_REQUIRED", score: 80,
      metrics: { currentPrice: 10_000, executionStrength: 95, vwapExtensionBps: -20, spreadBps: 12, bookImbalance: 0.3 },
    },
  }));
  const [row] = builder.finish();
  assert.equal(row.kind, "ENTRY_READY");
  assert.equal(row.exStr, 95);
  assert.equal(row.vwapExt, -20);
  assert.equal(row.stage, "CONFIRMATION_REQUIRED");
});
