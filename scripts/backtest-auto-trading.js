import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { backtestAutoTrading } from "../server/domain/autoTradingBacktest.js";
import { readRealtimeResearchEvents } from "../server/domain/realtimeResearchJournal.js";

// 2026-10-02 이전 자동매매 규칙(진입 필터·손절 유예·연속 손실 제한 없음, 익절 150).
// 새 규칙과 같은 기록으로 나란히 돌려 차이를 본다.
const PREVIOUS_RULES = Object.freeze({
  takeProfitBps: 150,
  stopConfirmMs: 0,
  entryMinimumExecutionStrength: null,
  entryMinimumVwapExtensionBps: null,
  entryConfirmMs: 0,
  noEntryWindows: [],
  minimumStopTicks: 0,
  minimumRewardRiskRatio: 0,
  maxConsecutiveLossesPerDay: 0,
});

try {
  const { filePaths, outputPath, overrides } = parseArguments(process.argv.slice(2));
  const events = filePaths.flatMap((filePath) => readRealtimeResearchEvents(filePath));
  const previous = await backtestAutoTrading(events, { settings: { ...PREVIOUS_RULES, ...overrides } });
  const current = await backtestAutoTrading(events, { settings: overrides });
  const result = { files: filePaths, previousRules: previous, currentRules: current };

  process.stdout.write(`기록 구간: ${formatTime(current.firstTimestamp)} ~ ${formatTime(current.lastTimestamp)}\n\n`);
  for (const [label, run] of [["이전 규칙", previous], ["새 규칙", current]]) {
    const summary = run.summary;
    process.stdout.write(`[${label}] 매매 ${summary.tradeCount}건 · 승 ${summary.wins} / 패 ${summary.losses}`
      + ` · 순손익 ${summary.totalNetPnl}원 · 평균 ${summary.averageNetReturnBps ?? "-"}bp`
      + ` · 손익비 ${summary.payoffRatio ?? "-"}\n`);
    for (const trade of run.trades) {
      process.stdout.write(`  ${formatTime(trade.openedAt)} → ${formatTime(trade.closedAt)} ${trade.symbol}`
        + ` ${trade.name ?? ""} ${trade.quantity}주 ${trade.entryPrice} → ${trade.exitPrice}`
        + ` ${trade.exitReason} 순손익 ${trade.netPnl}원 (${trade.netReturnBps}bp)\n`);
    }
    for (const position of run.openPositions) {
      process.stdout.write(`  (보유 중) ${position.symbol} ${position.quantity}주 ${position.averagePrice} → 평가 ${position.markPrice}`
        + ` 순손익 ${position.netPnl}원\n`);
    }
    process.stdout.write(`  진입 차단 사유: ${JSON.stringify(run.entrySkipReasons)}\n\n`);
  }
  process.stdout.write(`${current.warnings.join("\n")}\n`);
  if (outputPath) writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function parseArguments(args) {
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length === 0) {
    throw new Error(
      "사용법: node scripts/backtest-auto-trading.js <research.jsonl> [더 많은 파일...] "
      + "[--settings='{\"takeProfitBps\":300}'] [--output=result.json]",
    );
  }
  const values = Object.fromEntries(args
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const separator = arg.indexOf("=");
      return separator < 0 ? [arg.slice(2), "true"] : [arg.slice(2, separator), arg.slice(separator + 1)];
    }));
  let overrides = {};
  if (values.settings) {
    try {
      overrides = JSON.parse(values.settings);
    } catch {
      throw new Error("--settings는 JSON 객체여야 합니다.");
    }
  }
  return {
    filePaths: positional.map((item) => resolve(item)),
    outputPath: values.output ? resolve(values.output) : null,
    overrides,
  };
}

function formatTime(timestamp) {
  if (!Number.isFinite(Number(timestamp))) return "-";
  return new Date(Number(timestamp)).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });
}
