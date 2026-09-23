import assert from "node:assert/strict";
import test from "node:test";
import { runWalkForwardBacktest } from "../domain/walkForwardBacktest.js";
import { DEFAULT_STRATEGY_SETTINGS } from "../domain/strategySettings.js";

const BASE_TIME = Date.parse("2026-08-04T09:00:00Z");

function event(sequence, timestamp, type, payload) {
  return { schemaVersion: 1, eventId: `e${sequence}`, sessionId: "s1", sequence, timestamp, type, payload };
}

function scannerRefresh(sequence, timestamp, { symbol = "005930", tickSize = 100 } = {}) {
  return event(sequence, timestamp, "SCANNER_REFRESH", {
    candidates: [{ symbol, stage: "WATCH", orderBook: { tickSize } }],
  });
}

// 매수 1~3호가 잔량이 압도적이고 모든 체결이 최우선 매도호가 이상에서 발생하도록 구성해
// analysis.js의 weightedImbalance·tradeFlow가 모두 강한 양수가 되어 BUY 신호를 만든다.
function buyImbalancedMarketData(sequence, timestamp, { symbol = "005930", price = 70_000 } = {}) {
  return event(sequence, timestamp, "REALTIME_MARKET_DATA", {
    snapshot: {
      symbol,
      orderBook: {
        bestAsk: price,
        bestBid: price - 100,
        bids: [{ price: price - 100, size: 100_000 }],
        asks: [{ price, size: 10 }],
      },
      trade: {
        currentPrice: price,
        tradeVolume: 50,
        businessDate: "20260804",
        tradeTime: String(timestamp),
      },
    },
  });
}

function lowConfidenceSettingsVersion(version = 1) {
  return {
    version,
    timestamp: 0,
    previous: DEFAULT_STRATEGY_SETTINGS,
    next: { ...DEFAULT_STRATEGY_SETTINGS, entryMinimumConfidence: 10, exitMinimumConfidence: 10, orderQuantity: 5 },
  };
}

test("a strong buy-imbalanced recording produces filled orders and results are partitioned per window", () => {
  const events = [scannerRefresh(1, BASE_TIME)];
  for (let index = 0; index < 6; index += 1) {
    events.push(buyImbalancedMarketData(2 + index, BASE_TIME + index * 500, { price: 70_000 + index * 100 }));
  }
  const report = runWalkForwardBacktest({
    events,
    strategySettingsVersions: [lowConfidenceSettingsVersion(1)],
    windowCount: 2,
  });

  assert.equal(report.model, "WALK_FORWARD_DIAGNOSTIC_NO_LIVE_ORDER_MODEL");
  assert.deepEqual(report.symbolsObserved, ["005930"]);
  assert.equal(report.results.length, 2);
  assert.equal(report.results[0].windowIndex, 0);
  assert.equal(report.results[1].windowIndex, 1);
  const totalOrders = report.results.reduce((sum, item) => sum + item.totalOrderCount, 0);
  const totalFills = report.results.reduce((sum, item) => sum + item.totalFillCount, 0);
  assert.ok(totalOrders > 0, "expected at least one strategy-triggered order across windows");
  assert.ok(totalFills > 0, "expected at least one fill across windows");
});

test("comparing two settings versions produces one result row per version per window", () => {
  const events = [scannerRefresh(1, BASE_TIME)];
  for (let index = 0; index < 4; index += 1) {
    events.push(buyImbalancedMarketData(2 + index, BASE_TIME + index * 500, { price: 70_000 + index * 100 }));
  }
  const report = runWalkForwardBacktest({
    events,
    strategySettingsVersions: [lowConfidenceSettingsVersion(1), lowConfidenceSettingsVersion(2)],
    windowCount: 1,
  });
  assert.equal(report.results.length, 2);
  assert.deepEqual(report.versionsCompared, [1, 2]);
});

test("market data for a symbol never seen in a SCANNER_REFRESH is skipped for lack of a known tick size", () => {
  const events = [buyImbalancedMarketData(1, 0)];
  const report = runWalkForwardBacktest({
    events,
    strategySettingsVersions: [lowConfidenceSettingsVersion()],
    windowCount: 1,
  });
  assert.deepEqual(report.symbolsObserved, []);
  assert.equal(report.results[0].symbolCount, 0);
});

test("empty events, empty settings versions, and an invalid window count are all rejected", () => {
  assert.throws(() => runWalkForwardBacktest({ events: [], strategySettingsVersions: [lowConfidenceSettingsVersion()] }), TypeError);
  assert.throws(() => runWalkForwardBacktest({ events: [scannerRefresh(1, 0)], strategySettingsVersions: [] }), TypeError);
  assert.throws(() => runWalkForwardBacktest({
    events: [scannerRefresh(1, 0)],
    strategySettingsVersions: [lowConfidenceSettingsVersion()],
    windowCount: 0,
  }), TypeError);
});
