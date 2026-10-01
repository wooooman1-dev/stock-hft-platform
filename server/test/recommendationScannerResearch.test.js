import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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

test("스캐너 원본·상세·실시간 상태 전이를 연구 저널에 기록한다", async () => {
  const now = 1_000_000;
  const realtimeClient = new FakeRealtimeClient(now);
  const journal = fakeJournal();
  const scanner = new RecommendationScanner({
    dataClient: fakeDataClient(now),
    realtimeClient,
    researchJournal: journal,
    settings,
    now: () => now,
    sleep: async () => {},
  });

  const result = await scanner.refresh({ force: true });
  assert.equal(result.state, "READY");
  assert.equal(journal.refreshes.length, 1);
  assert.equal(journal.refreshes[0].universeSnapshot.rankings.volume.length, 1);
  assert.equal(journal.refreshes[0].details[0].minuteBars.length, 10);
  assert.equal(journal.refreshes[0].candidates[0].symbol, "005930");
  assert.equal(journal.transitions.some((item) => item.toState === "ENTRY_READY"), true);

  realtimeClient.emit("marketData", realtimeClient.snapshot("005930"));
  assert.equal(journal.marketData.length, 1);
  assert.equal(journal.marketData[0].snapshot.symbol, "005930");

  realtimeClient.emit("status", realtimeClient.status());
  assert.equal(journal.statuses.length, 1);

  scanner.stop();
  assert.equal(realtimeClient.stopped, true);
  assert.equal(journal.stopped, true);
});

class FakeRealtimeClient extends EventEmitter {
  constructor(now) {
    super();
    this.now = now;
    this.watched = [];
    this.stopped = false;
  }

  watchSymbols(items) {
    this.watched = items;
    return this.status();
  }

  status() {
    return {
      enabled: true,
      state: "CONNECTED",
      connected: true,
      desiredSymbolCount: this.watched.length,
      activeSubscriptionCount: this.watched.length * 2,
      automaticOrderConnected: false,
    };
  }

  snapshot(symbol) {
    return {
      symbol,
      connectionState: "CONNECTED",
      connected: true,
      venue: "KRX",
      staleAfterMs: 5_000,
      latestAt: this.now,
      orderBookAgeMs: 0,
      tradeAgeMs: 0,
      orderBook: {
        bestAsk: 10_140,
        bestBid: 10_130,
        totalAskSize: 12_000,
        totalBidSize: 18_000,
        receivedAt: this.now,
      },
      trade: {
        currentPrice: 10_140,
        weightedAveragePrice: 10_100,
        executionStrength: 120,
        accumulatedTradingValue: 20_000_000_000,
        tradingHalted: false,
        receivedAt: this.now,
      },
    };
  }

  stop() {
    this.stopped = true;
  }
}

function fakeJournal() {
  return {
    refreshes: [],
    marketData: [],
    statuses: [],
    errors: [],
    transitions: [],
    stopped: false,
    status() {
      return {
        enabled: true,
        state: "RECORDING",
        eventCount: this.refreshes.length + this.marketData.length,
        automaticOrderConnected: false,
      };
    },
    recordScannerRefresh(payload) { this.refreshes.push(payload); },
    recordRealtimeMarketData(payload) { this.marketData.push(payload); },
    recordConnectionStatus(payload) { this.statuses.push(payload); },
    recordError(payload) { this.errors.push(payload); },
    recordStateTransition(payload) { this.transitions.push(payload); },
    stop() { this.stopped = true; },
  };
}

function fakeDataClient(now) {
  return {
    status() {
      return {
        enabled: true,
        mode: "PROD_READ_ONLY",
        rankingApiAvailable: true,
        orderBookApiAvailable: true,
        minuteBarsApiAvailable: true,
        rawRankingSnapshotAvailable: true,
      };
    },
    async getUniverseSnapshot() {
      const candidate = {
        symbol: "005930",
        name: "삼성전자",
        market: "KRX",
        volumeRank: 1,
        fluctuationRank: 1,
        volumePowerRank: 1,
        executionStrength: 120,
        accumulatedTradingValue: 20_000_000_000,
      };
      return {
        fetchedAt: now,
        limit: 10,
        rankings: {
          volume: [{ mksc_shrn_iscd: "005930" }],
          fluctuation: [{ mksc_shrn_iscd: "005930" }],
          volumePower: [{ mksc_shrn_iscd: "005930" }],
        },
        merged: [candidate],
        candidates: [candidate],
      };
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
          fetchedAt: now,
        },
        orderBook: {
          bestBid: 10_130,
          bestAsk: 10_140,
          totalBidSize: 18_000,
          totalAskSize: 12_000,
        },
        minuteBars: bars(),
        fetchedAt: now,
      };
    },
  };
}

function bars() {
  const rows = [
    10_000, 10_030, 10_060, 10_090, 10_110,
    10_100, 10_090, 10_095, 10_120, 10_140,
  ];
  return rows.map((close, index) => ({
    time: `09${String(index).padStart(2, "0")}00`,
    open: close - 10,
    high: close + 10,
    low: close - 20,
    close,
    volume: index < 5 ? 2_200 : 900,
  }));
}
