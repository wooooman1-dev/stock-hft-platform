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

// 2026-10-01: "상승추세 종목을 빨리 찾아야 하는데 못 찾는 것 같다"는 지적으로
// 추가 — 한 번도 안 쉬고(눌림 없이) 꾸준히 신고점을 갱신하는 패턴은 PULLBACK/
// REVERSAL 둘 다 핵심 가산점(눌림·반등 전제)을 못 받는다. MOMENTUM 경로가 이
// 패턴을 잡아내 CONFIRMATION_REQUIRED까지 끌어올리는지 확인한다.
test("눌림 없이 꾸준히 신고점을 갱신하는 후보는 MOMENTUM으로 분류되고 진입 확인 문턱에 도달한다", () => {
  const bars = [
    bar("090000", 10000, 10050, 9995, 10040, 1000),
    bar("090100", 10040, 10090, 10030, 10080, 1000),
    bar("090200", 10080, 10130, 10070, 10120, 1000),
    bar("090300", 10120, 10170, 10110, 10160, 1000),
    bar("090400", 10160, 10210, 10150, 10200, 1000),
    bar("090500", 10200, 10250, 10190, 10240, 1000),
    bar("090600", 10240, 10290, 10230, 10280, 1000),
    bar("090700", 10280, 10330, 10270, 10320, 1000),
    bar("090800", 10320, 10370, 10310, 10360, 1000),
    bar("090900", 10360, 10410, 10350, 10400, 1000),
  ];
  const result = evaluateRecommendationCandidate({
    symbol: "005930",
    name: "쉬지않고상승",
    market: "KRX",
    currentPrice: 10400,
    changePercent: 4,
    accumulatedTradingValue: 20_000_000_000,
    tickSize: 10,
    orderBook: { bestBid: 10390, bestAsk: 10400, totalBidSize: 18000, totalAskSize: 10000 },
    minuteBars: bars,
    fetchedAt: Date.now(),
  }, settings);
  assert.equal(result.microstructure.pullbackDepthBps <= 20, true, "눌림이 거의 없어야 이 테스트의 전제가 성립한다");
  assert.equal(result.candidateType, "MOMENTUM");
  assert.notEqual(result.stage, "BLOCKED");
  assert.equal(result.stage, "CONFIRMATION_REQUIRED");
  assert.ok(result.score >= 75);
});

// 2026-10-06 파미셀: 최근 4분봉이 -110bp 하락하는 중에 눌림목 점수 84로 진입해 반등
// 없이 2분 만에 손절됐다. 재상승 가산점(16점)이 없어도 나머지 항목만으로 84점이
// 나왔기 때문이다. 재상승 확인 전에는 진입 확인 단계(75점)에 오를 수 없어야 한다.
test("눌리는 도중(재상승 확인 전)인 눌림목 후보는 다른 조건이 좋아도 WATCH에 머문다", () => {
  const closes = [9800, 9850, 9900, 9950, 10000, 10050, 10040, 10010, 9990, 9970];
  const bars = closes.map((close, index) => bar(
    `09${String(index).padStart(2, "0")}00`,
    close + 5,
    close + 10,
    close - 10,
    close,
    index < 6 ? 2000 : 900,
  ));
  const result = evaluateRecommendationCandidate({
    symbol: "005690",
    name: "눌림중",
    currentPrice: 9970,
    changePercent: 9,
    accumulatedTradingValue: 20_000_000_000,
    tickSize: 10,
    orderBook: { bestBid: 9960, bestAsk: 9970, totalBidSize: 18000, totalAskSize: 10000 },
    minuteBars: bars,
    fetchedAt: Date.now(),
  }, settings);
  assert.ok(result.microstructure.recentReturnBps < 0, "최근 분봉이 하락 중이라는 전제");
  assert.equal(result.candidateType, "PULLBACK");
  assert.equal(result.stage, "WATCH");
  assert.ok(result.score <= 74);
  assert.equal(result.reasons[0], "재상승 확인 전 — 진입 대기");
});

test("반전형도 재상승 확인 전에는 진입 확인 단계에 오르지 못한다", () => {
  const closes = [10000, 9960, 9920, 9880, 9840, 9800, 9795, 9800, 9802, 9801];
  const lows = [9990, 9950, 9910, 9870, 9830, 9790, 9785, 9790, 9795, 9798];
  const bars = closes.map((close, index) => bar(
    `09${String(index).padStart(2, "0")}00`, close, close + 10, lows[index], close, 1000,
  ));
  const result = evaluateRecommendationCandidate({
    symbol: "000001",
    name: "반전대기",
    currentPrice: 9815,
    changePercent: -0.5,
    accumulatedTradingValue: 20_000_000_000,
    executionStrength: 118,
    tickSize: 10,
    orderBook: { bestBid: 9810, bestAsk: 9815, totalBidSize: 18000, totalAskSize: 10000 },
    minuteBars: bars,
    fetchedAt: Date.now(),
  }, settings);
  assert.ok(result.microstructure.recentReturnBps < 8, "아직 재상승이 확인되지 않았다는 전제");
  assert.equal(result.candidateType, "REVERSAL");
  assert.equal(result.stage, "WATCH");
  assert.ok(result.score <= 74);
});

test("신규상장 종목은 당일 상승률·상한가 근접 가드가 완화되지만 VWAP 이격 가드는 유지된다", () => {
  const bars = Array.from({ length: 10 }, (_, index) => bar(
    `09${String(index).padStart(2, "0")}00`,
    10000 + index * 100,
    10100 + index * 100,
    9950 + index * 100,
    10050 + index * 100,
    1000,
  ));
  const result = evaluateRecommendationCandidate({
    symbol: "069500",
    name: "새내기전자",
    isNewlyListed: true,
    daysSinceListing: 3,
    listingDate: "2026-09-21",
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
  assert.equal(result.isNewlyListed, true);
  assert.equal(result.daysSinceListing, 3);
  assert.equal(result.blockReasons.some((reason) => reason.includes("당일 상승률")), false);
  assert.equal(result.blockReasons.some((reason) => reason.includes("상한가")), false);
  assert.ok(result.blockReasons.some((reason) => reason.includes("VWAP")));
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
