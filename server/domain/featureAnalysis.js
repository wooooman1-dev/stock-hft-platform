// 신호 데이터셋의 특징(feature)별로 "값이 높을수록 이후 수익이 어떻게 달라지는가"를 5분위로 잰다.
// 점수·게이트처럼 코드에 박힌 구성요소가 실제로 방향성을 맞히는지 확인하려는 도구다
// (2026-10-07: 종합 점수는 예측력이 없었고, 매수호가 우위 게이트는 오히려 역방향이었다).

export const DEFAULT_FEATURES = Object.freeze([
  "score", "chg", "exStr", "vwapExt", "spreadBps", "book", "recentRet", "priorRet", "dip", "nearHighBps", "volRatio",
]);
export const DEFAULT_HORIZONS = Object.freeze([
  { label: "5m", index: 9 },
  { label: "15m", index: 29 },
  { label: "30m", index: 59 },
]);

function pathValue(row, index) {
  const value = row.path?.[index];
  return value === null || value === undefined ? null : value;
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

// rows: 데이터셋 행. 기준선은 전체 평균이며, 각 분위의 값은 "기준선 대비 차이(bp)"다.
export function analyzeFeatures(rows, {
  features = DEFAULT_FEATURES, horizons = DEFAULT_HORIZONS, quantiles = 5, minimumRows = 500,
} = {}) {
  const baseline = {};
  for (const { label, index } of horizons) {
    baseline[label] = mean(rows.map((row) => pathValue(row, index)).filter((value) => value !== null));
  }
  const report = [];
  for (const feature of features) {
    const valued = rows
      .filter((row) => Number.isFinite(row[feature]))
      .sort((a, b) => a[feature] - b[feature]);
    if (valued.length < minimumRows) continue;
    const buckets = [];
    for (let bucket = 0; bucket < quantiles; bucket += 1) {
      const slice = valued.slice(
        Math.floor((valued.length * bucket) / quantiles),
        Math.floor((valued.length * (bucket + 1)) / quantiles),
      );
      const excess = {};
      for (const { label, index } of horizons) {
        const average = mean(slice.map((row) => pathValue(row, index)).filter((value) => value !== null));
        excess[label] = average === null || baseline[label] === null ? null : average - baseline[label];
      }
      buckets.push({ low: slice[0][feature], high: slice.at(-1)[feature], count: slice.length, excess });
    }
    report.push({ feature, count: valued.length, buckets });
  }
  return { baseline, report };
}
