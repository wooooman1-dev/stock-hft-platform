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

test("KIS 추천 데이터를 정밀 분석하고 점수순으로 반환한다", async () => {
  let now = 1_000_000;
  const client = fakeClient();
  const scanner = new RecommendationScanner({
    dataClient: client,
    settings,
    now: () => now,
    sleep: async () => {},
  });
  const first = await scanner.refresh({ force: true });
  assert.equal(first.state, "READY");
  assert.equal(first.candidates.length, 3);
  assert.equal(first.candidates[0].rank, 1);
  assert.equal(first.executionBoundary.automaticOrderConnected, false);
  assert.equal(first.status.dataSources.kis.rankingApiAvailable, true);
  const callsAfterFirst = client.calls.details;
  const cached = await scanner.get({ refreshIfStale: true });
  assert.equal(client.calls.details, callsAfterFirst);
  assert.deepEqual(cached.candidates.map((item) => item.symbol), first.candidates.map((item) => item.symbol));
  now += 16_000;
  await scanner.get({ refreshIfStale: true });
  assert.ok(client.calls.details > callsAfterFirst);
});

test("KIS 시세 연결이 없으면 DISABLED 상태와 빈 목록을 반환한다", async () => {
  const scanner = new RecommendationScanner({ settings });
  const snapshot = await scanner.get();
  assert.equal(snapshot.state, "DISABLED");
  assert.equal(snapshot.candidates.length, 0);
  assert.equal(snapshot.status.enabled, false);
});

function fakeClient() {
  const calls = { universe: 0, details: 0 };
  return {
    calls,
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
      calls.universe += 1;
      return [
        base("005930", "삼성전자", 1),
        base("000660", "SK하이닉스", 2),
        base("035420", "NAVER", 3),
      ];
    },
    async getCandidateDetails({ symbol }) {
      calls.details += 1;
      const offset = symbol === "005930" ? 0 : symbol === "000660" ? 200 : -100;
      const currentPrice = 10_140 + offset;
      return {
        quote: {
          currentPrice,
          basePrice: 9_900 + offset,
          openPrice: 10_000 + offset,
          highPrice: currentPrice + 20,
          lowPrice: 9_990 + offset,
          changePercent: 2.4,
          accumulatedVolume: 2_000_000,
          accumulatedTradingValue: 20_000_000_000,
          askUnit: 10,
          tradingHalted: false,
          fetchedAt: Date.now(),
        },
        orderBook: {
          bestBid: currentPrice - 10,
          bestAsk: currentPrice,
          totalBidSize: 18_000,
          totalAskSize: 12_000,
        },
        minuteBars: bars(offset),
        fetchedAt: Date.now(),
      };
    },
  };
}

function base(symbol, name, rank) {
  return {
    symbol,
    name,
    market: "KRX",
    volumeRank: rank,
    fluctuationRank: rank,
    volumePowerRank: rank,
    executionStrength: 120,
    accumulatedTradingValue: 20_000_000_000,
  };
}

function bars(offset) {
  const rows = [10000,10030,10060,10090,10110,10100,10090,10095,10120,10140];
  return rows.map((close, index) => ({
    time: `09${String(index).padStart(2, "0")}00`,
    open: close - 10 + offset,
    high: close + 10 + offset,
    low: close - 20 + offset,
    close: close + offset,
    volume: index < 5 ? 2200 : 900,
  }));
}

test("중요 위험 공시가 있으면 추천 후보를 차단하고 뉴스·커뮤니티는 보조정보로만 붙인다", async () => {
  const scanner = new RecommendationScanner({
    dataClient: fakeClient(),
    disclosureClient: {
      status: () => ({ enabled: true, state: "READY", role: "공시 위험 필터" }),
      async getRecentDisclosures({ stockCodes }) {
        return new Map(stockCodes.map((symbol) => [symbol, {
          enabled: true,
          count: 1,
          items: [],
          riskLevel: symbol === "005930" ? "HIGH" : "NONE",
          riskReasons: symbol === "005930" ? ["유상증자: 유상증자결정"] : [],
        }]));
      },
    },
    socialClient: {
      status: () => ({ enabled: true, state: "READY", newsApiAvailable: true, cafeApiAvailable: true }),
      async getSignals() {
        return {
          news: { total: 3, returned: 1, items: [{ title: "관련 뉴스" }] },
          community: { total: 5, returned: 1, items: [{ title: "관련 글" }] },
        };
      },
    },
    settings,
    now: () => 1_000_000,
    sleep: async () => {},
  });
  const result = await scanner.refresh({ force: true });
  const samsung = result.candidates.find((item) => item.symbol === "005930");
  assert.equal(samsung.stage, "BLOCKED");
  assert.match(samsung.blockReasons.join(" "), /중요 공시/);
  assert.equal(samsung.auxiliary.news.total, 3);
  assert.equal(samsung.auxiliary.policy.newsAffectsScore, false);
  assert.equal(result.status.dataSources.dart.enabled, true);
});
