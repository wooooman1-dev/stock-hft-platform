import test from "node:test";
import assert from "node:assert/strict";
import { backtestAutoTrading } from "../domain/autoTradingBacktest.js";
import { krxTickSize } from "../domain/kisPaperAutoTrader.js";

// 2026-10-02 10:00:00 KST — 진입 금지 시간대 밖
const START = Date.parse("2026-10-02T01:00:00Z");

function scannerRefresh(timestamp, candidate) {
  return { type: "SCANNER_REFRESH", timestamp, sequence: timestamp, payload: { candidates: [candidate] } };
}

function marketData(timestamp, { bid, ask, price, strength = 120 }) {
  return {
    type: "REALTIME_MARKET_DATA",
    timestamp,
    sequence: timestamp,
    payload: {
      snapshot: {
        symbol: "111110",
        connectionState: "CONNECTED",
        connected: true,
        orderBook: {
          bestBid: bid, bestAsk: ask, spread: ask - bid, spreadBps: ((ask - bid) / ((ask + bid) / 2)) * 10_000,
          bidAskImbalance: 0.3, totalBidSize: 2_000, totalAskSize: 1_000, receivedAt: timestamp,
        },
        trade: {
          currentPrice: price, executionStrength: strength, accumulatedVolume: 10_000,
          accumulatedTradingValue: 10_000 * price, receivedAt: timestamp,
        },
      },
    },
  };
}

const CANDIDATE = {
  symbol: "111110",
  name: "테스트",
  rank: 1,
  stage: "CONFIRMATION_REQUIRED",
  score: 84,
  currentPrice: 10_000,
  price: { vwap: 9_950 },
  microstructure: { spread: 10, spreadTicks: 1 },
};

test("기록을 시간순으로 흘려 실제 자동매매로 진입하고, 호가에 체결해 손절까지 계산한다", async () => {
  const events = [scannerRefresh(START, CANDIDATE)];
  // 40초 동안 ENTRY_READY 조건 유지 → 진입(매수는 매도호가 10,010)
  for (let second = 0; second <= 40; second += 1) {
    events.push(marketData(START + second * 1_000, { bid: 10_000, ask: 10_010, price: 10_000 }));
  }
  // 이후 하락해 손절선(-100bp) 아래에 머문다 → 매도는 매수호가 9_880
  for (let second = 41; second <= 60; second += 1) {
    events.push(marketData(START + second * 1_000, { bid: 9_880, ask: 9_890, price: 9_880 }));
  }
  const result = await backtestAutoTrading(events, {
    settings: { forcedExitTime: null, stopLossBps: 100, takeProfitBps: 250, trailingStopBps: null },
  });
  assert.equal(result.summary.tradeCount, 1);
  const [trade] = result.trades;
  assert.equal(trade.entryPrice, 10_010);
  assert.equal(trade.exitPrice, 9_880);
  assert.equal(trade.exitReason, "STOP_LOSS");
  assert.ok(trade.netPnl < 0);
  assert.ok(trade.openedAt - START >= 30_000, "ENTRY_READY가 30초 이어진 뒤에 산다");
});

test("체결강도가 100 미만이면 새 규칙에서는 사지 않는다", async () => {
  const events = [scannerRefresh(START, CANDIDATE)];
  for (let second = 0; second <= 60; second += 1) {
    events.push(marketData(START + second * 1_000, { bid: 10_000, ask: 10_010, price: 10_000, strength: 92 }));
  }
  const result = await backtestAutoTrading(events, { settings: { forcedExitTime: null } });
  assert.equal(result.summary.tradeCount, 0);
  assert.ok(result.entrySkipReasons.EXECUTION_STRENGTH_TOO_LOW > 0);
});

test("호가단위를 모르면 KRX 호가가격단위로 계산한다", () => {
  assert.equal(krxTickSize(1_999), 1);
  assert.equal(krxTickSize(4_995), 5);
  assert.equal(krxTickSize(19_990), 10);
  assert.equal(krxTickSize(93_400), 100);
  assert.equal(krxTickSize(243_000), 500);
  assert.equal(krxTickSize(500_000), 1_000);
});
