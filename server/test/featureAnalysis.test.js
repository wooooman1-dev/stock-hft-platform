import test from "node:test";
import assert from "node:assert/strict";
import { analyzeFeatures } from "../domain/featureAnalysis.js";

// 특징 값이 클수록 이후 5분 수익이 큰 합성 데이터(기울기 1bp/단위).
function rows(count) {
  return Array.from({ length: count }, (_, index) => ({
    kind: "SNAPSHOT", feature: index, path: [...Array(9).fill(0), index],
  }));
}

test("특징 값이 클수록 수익이 큰 데이터는 5분위 차이가 위로 갈수록 커진다", () => {
  const { baseline, report } = analyzeFeatures(rows(1_000), { features: ["feature"], minimumRows: 100 });
  assert.equal(baseline["5m"], 499.5);
  const buckets = report[0].buckets;
  assert.equal(buckets.length, 5);
  assert.ok(buckets[0].excess["5m"] < 0 && buckets[4].excess["5m"] > 0);
  for (let index = 1; index < 5; index += 1) assert.ok(buckets[index].excess["5m"] > buckets[index - 1].excess["5m"]);
  assert.equal(buckets[0].low, 0);
  assert.equal(buckets[4].high, 999);
});

test("표본이 너무 적거나 값이 없는 특징은 건너뛴다", () => {
  const { report } = analyzeFeatures(rows(50), { features: ["feature", "missing"], minimumRows: 100 });
  assert.deepEqual(report, []);
});
