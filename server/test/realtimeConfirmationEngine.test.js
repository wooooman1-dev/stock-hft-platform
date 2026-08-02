import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateRealtimeConfirmation,
  summarizeRealtimeStates,
} from "../domain/realtimeConfirmationEngine.js";

const candidate = {
  symbol: "005930",
  stage: "CONFIRMATION_REQUIRED",
  blockReasons: [],
};

test("호가와 체결이 최신이고 보수 조건을 통과하면 ENTRY_READY 분석 상태가 된다", () => {
  const now = 1_000_000;
  const result = evaluateRealtimeConfirmation(candidate, snapshot(now), { now });
  assert.equal(result.state, "ENTRY_READY");
  assert.equal(result.automaticOrderConnected, false);
  assert.equal(result.provisional, true);
  assert.equal(result.metrics.executionStrength, 125);
});

test("WebSocket 단절과 stale 데이터를 각각 구분한다", () => {
  const disconnected = evaluateRealtimeConfirmation(candidate, {
    ...snapshot(1_000_000),
    connected: false,
    connectionState: "DISCONNECTED",
  }, { now: 1_000_000 });
  assert.equal(disconnected.state, "DISCONNECTED");

  const stale = evaluateRealtimeConfirmation(candidate, snapshot(990_000), {
    now: 1_000_000,
    staleAfterMs: 5_000,
  });
  assert.equal(stale.state, "STALE");
});

test("스프레드 또는 추격 이격이 크면 BLOCKED 처리한다", () => {
  const wide = snapshot(1_000_000);
  wide.orderBook.bestAsk = 71_000;
  wide.orderBook.bestBid = 70_000;
  const result = evaluateRealtimeConfirmation(candidate, wide, { now: 1_000_000 });
  assert.equal(result.state, "BLOCKED");
  assert.match(result.reasons.join(" "), /스프레드/);
});

test("실시간 상태 집계를 반환한다", () => {
  const counts = summarizeRealtimeStates([
    { realtime: { state: "ENTRY_READY" } },
    { realtime: { state: "WATCH" } },
    { realtime: { state: "ENTRY_READY" } },
  ]);
  assert.equal(counts.ENTRY_READY, 2);
  assert.equal(counts.WATCH, 1);
});

function snapshot(receivedAt) {
  return {
    connectionState: "CONNECTED",
    connected: true,
    venue: "KRX",
    latestAt: receivedAt,
    orderBookAgeMs: 0,
    tradeAgeMs: 0,
    orderBook: {
      bestAsk: 70_100,
      bestBid: 70_000,
      totalAskSize: 10_000,
      totalBidSize: 15_000,
      receivedAt,
    },
    trade: {
      currentPrice: 70_050,
      weightedAveragePrice: 69_950,
      executionStrength: 125,
      tradeVolume: 100,
      accumulatedTradingValue: 10_000_000_000,
      tradingHalted: false,
      receivedAt,
    },
  };
}
