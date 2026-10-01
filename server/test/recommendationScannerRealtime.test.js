import test from "node:test";
import assert from "node:assert/strict";
import { RecommendationScanner } from "../domain/recommendationScanner.js";

const settings = {
  cacheTtlMs: 15_000,
  maxUniverse: 10,
  maxEnriched: 3,
  minimumTradingValue: 1_000_000_000,
  targetNetProfitBps: 300,
  buyCommissionBps: 1.40527,
  sellCommissionBps: 1.40527,
  sellTaxBps: 20,
  expectedSlippageTicks: 1,
  requestSpacingMs: 0,
};

test("추천 후보를 WebSocket 감시 목록에 등록하고 실시간 분석 상태를 붙인다", async () => {
  const now = 1_000_000;
  let watched = [];
  const realtimeClient = {
    status: () => ({
      enabled: true,
      state: "CONNECTED",
      connected: true,
      desiredSymbolCount: 1,
      activeSubscriptionCount: 2,
      automaticOrderConnected: false,
    }),
    watchSymbols(items) { watched = items; },
    snapshot(symbol) {
      return {
        symbol,
        connectionState: "CONNECTED",
        connected: true,
        venue: "KRX",
        staleAfterMs: 5_000,
        latestAt: now,
        orderBookAgeMs: 0,
        tradeAgeMs: 0,
        orderBook: {
          bestAsk: 10_140,
          bestBid: 10_130,
          totalAskSize: 12_000,
          totalBidSize: 18_000,
          receivedAt: now,
        },
        trade: {
          currentPrice: 10_140,
          weightedAveragePrice: 10_100,
          executionStrength: 120,
          accumulatedTradingValue: 20_000_000_000,
          tradingHalted: false,
          receivedAt: now,
        },
      };
    },
  };
  const scanner = new RecommendationScanner({
    dataClient: fakeClient(),
    realtimeClient,
    settings,
    now: () => now,
    sleep: async () => {},
  });

  const result = await scanner.refresh({ force: true });

  assert.deepEqual(watched, [{ symbol: "005930", venue: "KRX" }]);
  assert.equal(result.candidates[0].stage, "CONFIRMATION_REQUIRED");
  assert.equal(result.candidates[0].realtime.state, "ENTRY_READY");
  assert.equal(result.realtimeStateCounts.ENTRY_READY, 1);
  assert.equal(result.executionBoundary.automaticOrderConnected, false);
  assert.equal(result.executionBoundary.realtimeEntryReadyIsOrderSignal, false);
  assert.equal(result.status.dataSources.kis.realtimeConfirmationAvailable, true);
});

// 2026-10-01: "상승추세 종목을 못 찾는다"는 지적으로 추가 — 실시간 추격 제한
// (maximumRealtimeChaseBps)이 설정값대로 실제 실시간 확인 호출에 전달되는지
// 확인한다. VWAP 대비 약 242bp 벌어진 스냅샷은 옛 기본값(150)이면 막히고
// 새 기본값(300)이면 통과해야 하며, 설정으로 더 타이트하게 되돌리면 다시 막혀야 한다.
test("maximumRealtimeChaseBps 설정이 실시간 확인에 실제로 전달된다", async () => {
  const now = 1_000_000;
  const chaseSnapshot = {
    symbol: "005930",
    connectionState: "CONNECTED",
    connected: true,
    venue: "KRX",
    staleAfterMs: 5_000,
    latestAt: now,
    orderBookAgeMs: 0,
    tradeAgeMs: 0,
    orderBook: {
      bestAsk: 10_140, bestBid: 10_130, totalAskSize: 12_000, totalBidSize: 18_000, receivedAt: now,
    },
    trade: {
      currentPrice: 10_140,
      // vwapExtensionBps ≈ (10140-9900)/9900*10000 ≈ 242.4bp — 옛 기본값(150)
      // 과 새 기본값(300) 사이.
      weightedAveragePrice: 9_900,
      executionStrength: 120,
      accumulatedTradingValue: 20_000_000_000,
      tradingHalted: false,
      receivedAt: now,
    },
  };
  const realtimeClient = {
    status: () => ({ enabled: true, state: "CONNECTED", connected: true, desiredSymbolCount: 1, activeSubscriptionCount: 1, automaticOrderConnected: false }),
    watchSymbols() {},
    snapshot: () => chaseSnapshot,
  };

  const defaultScanner = new RecommendationScanner({
    dataClient: fakeClient(), realtimeClient, settings, now: () => now, sleep: async () => {},
  });
  const defaultResult = await defaultScanner.refresh({ force: true });
  assert.equal(defaultResult.candidates[0].realtime.state, "ENTRY_READY", "새 기본값(300bp)이면 통과해야 한다");

  const tightScanner = new RecommendationScanner({
    dataClient: fakeClient(), realtimeClient,
    settings: { ...settings, maximumRealtimeChaseBps: 150 },
    now: () => now, sleep: async () => {},
  });
  const tightResult = await tightScanner.refresh({ force: true });
  assert.equal(tightResult.candidates[0].realtime.state, "BLOCKED", "150bp로 되돌리면 추격 제한에 걸려야 한다");
});

function fakeClient() {
  return {
    status() {
      return {
        enabled: true,
        mode: "PROD_READ_ONLY",
        rankingApiAvailable: true,
        orderBookApiAvailable: true,
        minuteBarsApiAvailable: true,
        realtimeConfirmationAvailable: false,
      };
    },
    async getUniverse() {
      return [{
        symbol: "005930",
        name: "삼성전자",
        market: "KRX",
        volumeRank: 1,
        fluctuationRank: 1,
        volumePowerRank: 1,
        executionStrength: 120,
        accumulatedTradingValue: 20_000_000_000,
      }];
    },
    async getCandidateDetails() {
      return {
        quote: {
          currentPrice: 10_140,
          basePrice: 9_900,
          openPrice: 10_000,
          highPrice: 10_160,
          lowPrice: 9_990,
          changePercent: 2.4,
          accumulatedVolume: 2_000_000,
          accumulatedTradingValue: 20_000_000_000,
          askUnit: 10,
          tradingHalted: false,
          fetchedAt: 1_000_000,
        },
        orderBook: {
          bestBid: 10_130,
          bestAsk: 10_140,
          totalBidSize: 18_000,
          totalAskSize: 12_000,
        },
        minuteBars: bars(),
        fetchedAt: 1_000_000,
      };
    },
  };
}

function bars() {
  const rows = [10_000, 10_030, 10_060, 10_090, 10_110, 10_100, 10_090, 10_095, 10_120, 10_140];
  return rows.map((close, index) => ({
    time: `09${String(index).padStart(2, "0")}00`,
    open: close - 10,
    high: close + 10,
    low: close - 20,
    close,
    volume: index < 5 ? 2_200 : 900,
  }));
}
