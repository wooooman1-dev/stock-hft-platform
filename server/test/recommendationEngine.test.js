import test from "node:test";
import assert from "node:assert/strict";
import { estimateTarget, evaluateRecommendationCandidate } from "../domain/recommendationEngine.js";

const settings = {
  cacheTtlMs: 15_000,
  maxUniverse: 30,
  maxEnriched: 8,
  minimumTradingValue: 1_000_000_000,
  targetNetProfitBps: 300,
  buyCommissionBps: 1.40527,
  sellCommissionBps: 1.40527,
  sellTaxBps: 20,
  expectedSlippageTicks: 1,
  requestSpacingMs: 0,
};

test("비용 추정과 3% 순수익 목표를 반영해 목표가를 호가단위로 올림한다", () => {
  const target = estimateTarget(10_000, 10, settings);
  assert.equal(target.targetNetProfitPercent, 3);
  assert.ok(target.breakEvenPrice > 10_000);
  assert.ok(target.targetPrice >= 10_300);
  assert.equal(target.targetPrice % 10, 0);
});

test("상승 추세의 짧은 눌림 후 재상승 후보를 PULLBACK으로 분류한다", () => {
  const bars = [
    bar("090000", 10000, 10010, 9990, 10000, 2000),
    bar("090100", 10000, 10040, 9995, 10030, 2200),
    bar("090200", 10030, 10070, 10020, 10060, 2300),
    bar("090300", 10060, 10100, 10050, 10090, 2400),
    bar("090400", 10090, 10120, 10070, 10110, 2500),
    bar("090500", 10110, 10130, 10090, 10100, 1000),
    bar("090600", 10100, 10115, 10080, 10090, 900),
    bar("090700", 10090, 10105, 10085, 10095, 800),
    bar("090800", 10095, 10125, 10090, 10120, 1000),
    bar("090900", 10120, 10145, 10110, 10140, 1200),
  ];
  const result = evaluateRecommendationCandidate({
    symbol: "005930",
    name: "삼성전자",
    market: "KRX",
    currentPrice: 10140,
    previousClose: 9900,
    openPrice: 10000,
    highPrice: 10145,
    lowPrice: 9990,
    changePercent: 2.42,
    accumulatedVolume: 2_000_000,
    accumulatedTradingValue: 20_000_000_000,
    executionStrength: 118,
    tickSize: 10,
    orderBook: { bestBid: 10130, bestAsk: 10140, totalBidSize: 18000, totalAskSize: 12000 },
    minuteBars: bars,
    fetchedAt: Date.now(),
  }, settings);
  assert.equal(result.candidateType, "PULLBACK");
  assert.notEqual(result.stage, "BLOCKED");
  assert.ok(result.score >= 55);
  assert.ok(result.reasons.length > 0);
});

test("거래대금과 분봉이 부족한 후보는 BLOCKED 처리한다", () => {
  const result = evaluateRecommendationCandidate({
    symbol: "000001",
    name: "테스트",
    currentPrice: 5000,
    changePercent: 1,
    accumulatedTradingValue: 10_000_000,
    tickSize: 5,
    orderBook: { bestBid: 4995, bestAsk: 5000, totalBidSize: 100, totalAskSize: 100 },
    minuteBars: [bar("090000", 5000, 5000, 5000, 5000, 10)],
    fetchedAt: Date.now(),
  }, settings);
  assert.equal(result.stage, "BLOCKED");
  assert.ok(result.blockReasons.some((reason) => reason.includes("거래대금")));
  assert.ok(result.blockReasons.some((reason) => reason.includes("분봉")));
});


test("급등·VWAP 과이격·상한가 근접 후보는 감시 점수와 무관하게 BLOCKED 처리한다", () => {
  const bars = Array.from({ length: 10 }, (_, index) => bar(
    `09${String(index).padStart(2, "0")}00`,
    10000 + index * 100,
    10100 + index * 100,
    9950 + index * 100,
    10050 + index * 100,
    1000,
  ));
  const result = evaluateRecommendationCandidate({
    symbol: "005930",
    name: "과열테스트",
    currentPrice: 12500,
    previousClose: 10000,
    openPrice: 10100,
    highPrice: 12600,
    lowPrice: 10000,
    upperLimitPrice: 13000,
    changePercent: 25,
    accumulatedTradingValue: 100_000_000_000,
    executionStrength: 140,
    tickSize: 10,
    orderBook: { bestBid: 12490, bestAsk: 12500, totalBidSize: 20000, totalAskSize: 10000 },
    minuteBars: bars,
    fetchedAt: Date.now(),
  }, settings);
  assert.equal(result.stage, "BLOCKED");
  assert.ok(result.blockReasons.some((reason) => reason.includes("당일 상승률")));
  assert.ok(result.blockReasons.some((reason) => reason.includes("VWAP")));
  assert.ok(result.blockReasons.some((reason) => reason.includes("상한가")));
});

function bar(time, open, high, low, close, volume) {
  return { time, open, high, low, close, volume };
}

// 2026-09-10 확인: 통합 시장구분으로 분봉을 조회하면 30행이 전부 0으로 돌아왔는데,
// 평가 단계가 이를 "분봉 8개 미만"으로 뭉개 데이터 결함이 전략 판정처럼 보였다.
test("분봉 응답이 전부 빈 값이면 데이터 결함으로 구분해 표시한다", () => {
  const zeroBars = Array.from({ length: 30 }, (_, i) => ({
    time: String(90000 + i), open: 0, high: 0, low: 0, close: 0, volume: 0,
  }));
  const result = evaluateRecommendationCandidate({
    symbol: "036930",
    currentPrice: 202500,
    accumulatedTradingValue: 76_995_647_250,
    executionStrength: 118,
    tickSize: 500,
    orderBook: { bestBid: 202000, bestAsk: 202500, tickSize: 500 },
    minuteBars: zeroBars,
  });
  const joined = result.blockReasons.join(" | ");
  assert.match(joined, /분봉 응답 30건이 모두 빈 값/);
  assert.doesNotMatch(joined, /분봉 데이터 8개 미만/, "빈 응답을 개수 부족으로 뭉개면 안 된다");
});

test("분봉이 실제로 모자란 경우는 종전대로 개수 부족으로 표시한다", () => {
  const fewBars = Array.from({ length: 3 }, (_, i) => ({
    time: String(90000 + i), open: 100, high: 101, low: 99, close: 100, volume: 10,
  }));
  const result = evaluateRecommendationCandidate({
    symbol: "005930",
    currentPrice: 100,
    accumulatedTradingValue: 76_995_647_250,
    executionStrength: 118,
    tickSize: 1,
    orderBook: { bestBid: 99, bestAsk: 100, tickSize: 1 },
    minuteBars: fewBars,
  });
  const joined = result.blockReasons.join(" | ");
  assert.match(joined, /분봉 데이터 8개 미만/);
  assert.doesNotMatch(joined, /모두 빈 값/);
});

// REST 체결강도는 순위 API마다 필드가 달라 결측될 수 있다. 그러나 ENTRY_READY의
// 체결강도 게이트는 실시간 체결이 판정하므로, REST 결측만으로 차단해서는 안 된다.
test("REST 체결강도 결측은 차단하지 않고 dataCompleteness로만 드러낸다", () => {
  const bars = Array.from({ length: 20 }, (_, i) => ({
    time: String(90000 + i), open: 100, high: 101, low: 99, close: 100, volume: 10,
  }));
  const result = evaluateRecommendationCandidate({
    symbol: "005930",
    currentPrice: 100,
    accumulatedTradingValue: 76_995_647_250,
    executionStrength: null,
    tickSize: 1,
    orderBook: { bestBid: 99, bestAsk: 100, tickSize: 1 },
    minuteBars: bars,
  });
  assert.equal(
    result.blockReasons.some((reason) => reason.includes("체결강도")),
    false,
    "REST 체결강도 결측으로 차단하면 안 된다",
  );
  assert.equal(result.dataCompleteness.complete, 5);
  assert.equal(result.dataCompleteness.total, 6);
});
