import test from "node:test";
import assert from "node:assert/strict";
import { replayRealtimeResearchEvents } from "../domain/realtimeResearchReplay.js";

test("기록 이벤트를 재생해 상태 전이와 전방 수익률을 계산한다", () => {
  const events = [
    event(1, 1_000, "SCANNER_REFRESH", {
      candidates: [{
        symbol: "005930",
        stage: "CONFIRMATION_REQUIRED",
        blockReasons: [],
      }],
    }),
    event(2, 1_100, "REALTIME_CONNECTION_STATUS", {
      state: "CONNECTED",
      connected: true,
    }),
    event(3, 1_200, "REALTIME_MARKET_DATA", {
      snapshot: snapshot(1_200, 70_000, 125),
    }),
    event(4, 2_300, "REALTIME_MARKET_DATA", {
      snapshot: snapshot(2_300, 70_100, 126),
    }),
    event(5, 6_300, "REALTIME_MARKET_DATA", {
      snapshot: snapshot(6_300, 70_350, 130),
    }),
  ];
  const result = replayRealtimeResearchEvents(events, {
    horizonsMs: [1_000, 5_000],
  });
  assert.equal(result.automaticOrderConnected, false);
  assert.equal(result.stateCounts.ENTRY_READY, 1);
  assert.equal(result.signals.length, 1);
  assert.equal(result.outcomeSummary[0].observedCount, 1);
  assert.equal(result.outcomeSummary[0].averageGrossReturnBps, 14.286);
  assert.equal(result.outcomeSummary[1].averageGrossReturnBps, 50);
  assert.equal(result.model, "OBSERVATIONAL_NO_FILL_MODEL");
});

test("후보 제외 시 DROPPED 전이를 기록한다", () => {
  const events = [
    event(1, 1_000, "SCANNER_REFRESH", {
      candidates: [{ symbol: "005930", stage: "WATCH" }],
    }),
    event(2, 2_000, "SCANNER_REFRESH", { candidates: [] }),
  ];
  const result = replayRealtimeResearchEvents(events);
  assert.equal(result.stateCounts.DROPPED, 1);
  assert.equal(result.perSymbol["005930"].states.DROPPED, 1);
});

function event(sequence, timestamp, type, payload) {
  return {
    schemaVersion: 1,
    eventId: `e${sequence}`,
    sessionId: "s1",
    sequence,
    timestamp,
    type,
    payload,
  };
}

function snapshot(receivedAt, currentPrice, executionStrength) {
  return {
    symbol: "005930",
    connectionState: "CONNECTED",
    connected: true,
    venue: "KRX",
    latestAt: receivedAt,
    orderBookAgeMs: 0,
    tradeAgeMs: 0,
    orderBook: {
      bestAsk: currentPrice + 10,
      bestBid: currentPrice,
      totalAskSize: 10_000,
      totalBidSize: 15_000,
      receivedAt,
    },
    trade: {
      currentPrice,
      weightedAveragePrice: currentPrice - 20,
      executionStrength,
      tradingHalted: false,
      receivedAt,
    },
  };
}
