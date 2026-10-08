import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { analyzeFeatures } from "../server/domain/featureAnalysis.js";

// 특징별 5분위 → 이후 수익 분석.  node scripts/analyze-features.js [--data <데이터셋 jsonl>] [--kind SNAPSHOT]
const optionIndex = (name) => process.argv.indexOf(name);
const dataPath = resolve(optionIndex("--data") === -1 ? ".pulsehft/analysis/signal-dataset.jsonl" : process.argv[optionIndex("--data") + 1]);
const kind = optionIndex("--kind") === -1 ? "SNAPSHOT" : process.argv[optionIndex("--kind") + 1];
const rows = [];
for await (const line of createInterface({ input: createReadStream(dataPath, { encoding: "utf8" }) })) {
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  if (row.kind === kind) rows.push(row);
}
const { baseline, report } = analyzeFeatures(rows);
const fmt = (value) => (value === null ? "  - " : `${value >= 0 ? "+" : ""}${value.toFixed(0)}`);
process.stdout.write(`행 ${rows.length}개(${kind}), 기준선 평균 수익(bp, 비용 전): ${Object.entries(baseline).map(([key, value]) => `${key} ${value?.toFixed(1)}`).join(" · ")}\n`);
process.stdout.write("각 분위: [값 범위] 기준선 대비 5m/15m/30m (bp)\n");
for (const item of report) {
  const cells = item.buckets.map((bucket) => `[${bucket.low.toFixed(1)}~${bucket.high.toFixed(1)}] ${["5m", "15m", "30m"].map((key) => fmt(bucket.excess[key])).join("/")}`);
  process.stdout.write(`${item.feature.padEnd(12)} n=${item.count}  ${cells.join("  ")}\n`);
}
