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
