import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { evaluateRule, passesAdoptionBar } from "../server/domain/ruleEvaluation.js";

// 신호 데이터셋으로 진입 규칙 × 청산 정책의 비용 차감 후 기대수익을 비교한다.
//   node scripts/evaluate-rules.js [--data .pulsehft/analysis/signal-dataset.jsonl] [--cost 23]
const dataPath = resolve(readOption("--data") ?? ".pulsehft/analysis/signal-dataset.jsonl");
const costBps = Number(readOption("--cost") ?? 23);
const rows = [];
for await (const line of createInterface({ input: createReadStream(dataPath, { encoding: "utf8" }) })) {
  if (line.trim()) rows.push(JSON.parse(line));
}

const snapshot = (row) => row.kind === "SNAPSHOT";
const READY = (row) => row.kind === "ENTRY_READY";
const filters = (row) => row.exStr >= 90 && row.vwapExt >= -50 && row.spreadBps <= 17.2;
const RULES = [
  ["전체 스냅샷(기준선)", snapshot],
  ["ENTRY_READY 전환", READY],
  ["ENTRY_READY + 현재 필터", (row) => READY(row) && filters(row)],
  ["스냅샷 확인 단계(75점+)", (row) => snapshot(row) && row.stage === "CONFIRMATION_REQUIRED"],
  ["스냅샷 눌림후재상승 확인", (row) => snapshot(row) && row.rerise === true],
  ["스냅샷 15분 눌림 상태", (row) => snapshot(row) && row.flowState === "UPTREND_PULLBACK"],
  ["신고점 근처+체결강도100+", (row) => snapshot(row) && row.nearHighBps !== null && row.nearHighBps <= 10 && row.chg > 0 && row.exStr >= 100],
  ["강한 종목(+3%, 최근 상승)", (row) => snapshot(row) && row.chg >= 3 && row.recentRet >= 8 && row.exStr >= 100],
  // 2026-10-07 특징 귀속 분석에서 나온 구간으로 미리 정한 규칙(탐색하지 않고 고정): 당일 고가 근처 + 적당한 상승.
  ["R1 고가근처(<=150bp)+등락 2.5~8.7%", (row) => snapshot(row) && row.nearHighBps !== null && row.nearHighBps <= 150 && row.chg >= 2.5 && row.chg <= 8.7],
  ["R2 = R1 + VWAP>=-10", (row) => snapshot(row) && row.nearHighBps !== null && row.nearHighBps <= 150 && row.chg >= 2.5 && row.chg <= 8.7 && row.vwapExt >= -10],
  ["R3 = R1 + 매수우위 아님(book<=0.05)", (row) => snapshot(row) && row.nearHighBps !== null && row.nearHighBps <= 150 && row.chg >= 2.5 && row.chg <= 8.7 && row.book !== null && row.book <= 0.05],
  ["R4 = R1 + 최근상승 과열 아님(<=25bp)", (row) => snapshot(row) && row.nearHighBps !== null && row.nearHighBps <= 150 && row.chg >= 2.5 && row.chg <= 8.7 && row.recentRet <= 25],
];
const EXITS = [
  ["5분 보유", { type: "hold", minutes: 5 }],
  ["10분 보유", { type: "hold", minutes: 10 }],
  ["30분 보유", { type: "hold", minutes: 30 }],
  ["60분 보유", { type: "hold", minutes: 60 }],
  ["손절100/익절250/30분", { type: "bracket", stopBps: 100, targetBps: 250, minutes: 30 }],
  ["트레일링(100 무장)/손절100/60분", { type: "trailing", armBps: 100, stopBps: 100, minutes: 60 }],
];

process.stdout.write(`데이터 ${rows.length}행, 비용 ${costBps}bp, 중복 제거 10분, 앞 60% 일자=학습/뒤 40%=검증\n`);
process.stdout.write("규칙 | 청산 | 건수 | 평균bp | 중앙bp | 승률 | t | 양수일비율 | 검증(건수/평균bp) | 적용기준\n");
for (const [ruleName, select] of RULES) {
  for (const [exitName, exit] of EXITS) {
    const result = evaluateRule(rows, { name: ruleName, select, exit, costBps });
    const all = result.all;
    if (all.count === 0) continue;
    process.stdout.write([
      ruleName, exitName, all.count, all.meanNetBps, all.medianNetBps,
      `${Math.round(all.winRate * 100)}%`, all.tStat ?? "-", `${Math.round(all.positiveDayRatio * 100)}%`,
      `${result.test.count}/${result.test.meanNetBps ?? "-"}`, passesAdoptionBar(result) ? "통과" : "-",
    ].join(" | ") + "\n");
  }
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
