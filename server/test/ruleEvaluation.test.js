import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRule, passesAdoptionBar, simulateExit, summarizeTrades } from "../domain/ruleEvaluation.js";

// 30초 간격 경로. 두 칸 = 1분.
test("보유시간 청산은 해당 시점의 수익률을 쓴다", () => {
  const path = [5, 10, 15, 20];
  assert.deepEqual(simulateExit(path, { type: "hold", minutes: 1 }), { gross: 10, reason: "TIME" });
  assert.deepEqual(simulateExit(path, { type: "hold", minutes: 2 }), { gross: 20, reason: "TIME" });
});

test("손절/익절은 먼저 닿는 쪽으로 청산한다", () => {
  const policy = { type: "bracket", stopBps: 100, targetBps: 150, minutes: 5 };
  assert.deepEqual(simulateExit([50, -120, 200], policy), { gross: -120, reason: "STOP" });
  assert.deepEqual(simulateExit([50, 160, -300], policy), { gross: 150, reason: "TARGET" });
  assert.deepEqual(simulateExit([10, 20, 30], policy), { gross: 30, reason: "TIME" });
});

test("트레일링은 무장 뒤 신고점이 아닌 첫 값에서 청산한다", () => {
  const policy = { type: "trailing", armBps: 100, stopBps: 100, minutes: 5 };
  assert.deepEqual(simulateExit([60, 120, 150, 140, 300], policy), { gross: 140, reason: "TRAIL" });
  assert.deepEqual(simulateExit([60, 90, 80, 95], policy), { gross: 95, reason: "TIME" }, "무장 전 하락은 청산하지 않는다");
});

test("경로가 전부 비어 있으면 평가할 수 없다", () => {
  assert.equal(simulateExit([null, null], { type: "hold", minutes: 1 }), null);
});

function row(day, symbol, ts, gross) {
  return { kind: "SNAPSHOT", day, symbol, ts: Date.parse(`${day}T01:00:00Z`) + ts, path: [gross, gross] };
}

test("규칙 평가는 비용을 빼고, 같은 종목 중복을 걸러내고, 학습/검증으로 나눈다", () => {
  const rows = [
    row("2026-10-01", "A", 0, 50),
    row("2026-10-01", "A", 60_000, 999), // 10분 안 중복 — 제외
    row("2026-10-02", "A", 0, 50),
    row("2026-10-03", "A", 0, -10),
    row("2026-10-06", "A", 0, 10),
    row("2026-10-07", "A", 0, 70),
  ];
  const result = evaluateRule(rows, {
    name: "t", select: () => true, exit: { type: "hold", minutes: 1 }, costBps: 20, trainRatio: 0.6,
  });
  assert.equal(result.all.count, 5);
  assert.equal(result.all.meanNetBps, (30 + 30 - 30 - 10 + 50) / 5);
  assert.equal(result.train.count, 3, "5일 중 앞 3일이 학습");
  assert.equal(result.test.count, 2);
  assert.equal(result.all.positiveDayRatio, 3 / 5);
});

test("적용 기준: 검증 구간 100건 이상·평균 양수·양수 일 비율 60% 이상", () => {
  const good = {
    test: { count: 120, meanNetBps: 5 }, all: { positiveDayRatio: 0.7 },
  };
  assert.equal(passesAdoptionBar(good), true);
  assert.equal(passesAdoptionBar({ ...good, test: { count: 99, meanNetBps: 5 } }), false);
  assert.equal(passesAdoptionBar({ ...good, test: { count: 120, meanNetBps: -1 } }), false);
  assert.equal(passesAdoptionBar({ ...good, all: { positiveDayRatio: 0.5 } }), false);
});

test("빈 거래 목록 요약은 건수 0이다", () => {
  assert.deepEqual(summarizeTrades([]), { count: 0 });
});
