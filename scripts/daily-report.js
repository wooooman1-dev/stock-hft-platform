import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildDailyReport, kstDay } from "../server/domain/dailyReport.js";
import { computePerformanceReport } from "../server/domain/kisPaperPerformance.js";

// 하루치 자동매매 결과 리포트.  node scripts/daily-report.js [YYYY-MM-DD] [--journal <경로>]
const dayArgument = process.argv.slice(2).find((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
const journalIndex = process.argv.indexOf("--journal");
const journalPath = resolve(journalIndex === -1 ? ".pulsehft/execution-journal.jsonl" : process.argv[journalIndex + 1]);
const events = readFileSync(journalPath, "utf8").split("\n").filter(Boolean).map((line) => {
  try { return JSON.parse(line); } catch { return null; }
}).filter(Boolean);
const day = dayArgument ?? kstDay(Date.now());
const performance = computePerformanceReport(events, {
  recentLimit: 0,
  costModel: { buyCommissionBps: 1.40527, sellCommissionBps: 1.40527, sellTaxBps: 20 },
});
const report = buildDailyReport({ events, trades: performance.trades.recent, day });

const line = (label, total) => `${label.padEnd(18)} ${String(total.count).padStart(3)}건 · 승 ${total.wins} · 총손익 ${total.gross}원 · 비용 ${total.cost}원 · 순손익 ${total.net}원`
  + (total.avgMfeBps === null ? "" : ` · 평균 최대상승 ${total.avgMfeBps}bp / 최대하락 ${total.avgMaeBps}bp`);
const out = [`# ${day} 자동매매 리포트`, `자동매매 주문 ${report.autoOrders}건 · 실현 거래 ${report.tradeCount}건`, line("합계", report.totals), ""];
for (const [title, groups] of [["청산 사유별", report.byExitReason], ["진입 유형별", report.byEntryType], ["진입 시각별(시)", report.byEntryHour]]) {
  out.push(`## ${title}`);
  for (const [key, total] of Object.entries(groups)) out.push(line(key, total));
  out.push("");
}
out.push("## 진입 필터 탈락(스캐너 ENTRY_READY 기준)");
out.push(`기록 ${report.entryGate.events}회 · 종목-사유 ${report.entryGate.distinctSymbolReasons}종`);
for (const [reason, count] of Object.entries(report.entryGate.reasons)) out.push(`  ${reason}: ${count}`);
out.push("", "## 거래 내역");
for (const trade of report.trades) {
  out.push(`${trade.name ?? trade.symbol} ${trade.entryType}@${trade.entryHour}시 → ${trade.exitReason}`
    + ` 순손익 ${Math.round(trade.net)}원 (최대상승 ${trade.mfeBps ?? "-"}bp / 최대하락 ${trade.maeBps ?? "-"}bp)`);
}
process.stdout.write(`${out.join("\n")}\n`);
