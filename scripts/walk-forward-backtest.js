import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRealtimeResearchEvents } from "../server/domain/realtimeResearchJournal.js";
import { runWalkForwardBacktest } from "../server/domain/walkForwardBacktest.js";
import { StrategySettingsStore } from "../server/domain/strategySettingsStore.js";
import { loadPaperCostModel } from "../server/domain/paperTrader.js";

try {
  const options = parseArguments(process.argv.slice(2));
  const events = readRealtimeResearchEvents(options.recordingPath);
  const store = new StrategySettingsStore(options.strategySettingsPath);
  const versions = options.versions.length > 0
    ? store.history().filter((entry) => options.versions.includes(entry.version))
    : store.history();
  if (versions.length === 0) {
    throw new Error(
      "비교할 전략 설정 버전이 없습니다. --strategy-settings-path가 가리키는 위치에서 "
      + "설정을 한 번 이상 저장(PUT /api/strategy/settings)해 이력을 만든 뒤 다시 실행하세요.",
    );
  }
  const result = runWalkForwardBacktest({
    events,
    strategySettingsVersions: versions,
    windowCount: options.windowCount,
    initialCash: options.initialCash,
    costModel: options.realisticCosts ? loadPaperCostModel(process.env) : {},
  });
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (options.outputPath) writeFileSync(options.outputPath, output, "utf8");
  process.stdout.write(output);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function parseArguments(args) {
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length !== 1) {
    throw new Error(
      "사용법: node scripts/walk-forward-backtest.js <research.jsonl> "
      + "[--strategy-settings-path=.pulsehft/strategy-settings.json] [--versions=1,3,5] "
      + "[--window-count=4] [--initial-cash=10000000] [--realistic-costs] [--output=result.json]",
    );
  }
  const flags = Object.fromEntries(args
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const separator = arg.indexOf("=");
      if (separator < 0) return [arg.slice(2), "true"];
      return [arg.slice(2, separator), arg.slice(separator + 1)];
    }));
  return {
    recordingPath: resolve(positional[0]),
    strategySettingsPath: resolve(flags["strategy-settings-path"] ?? ".pulsehft/strategy-settings.json"),
    versions: flags.versions
      ? flags.versions.split(",").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value))
      : [],
    windowCount: optionalInteger(flags["window-count"]) ?? 4,
    initialCash: optionalInteger(flags["initial-cash"]) ?? 10_000_000,
    realisticCosts: flags["realistic-costs"] === "true",
    outputPath: flags.output ? resolve(flags.output) : null,
  };
}

function optionalInteger(value) {
  if (value === undefined || value === "") return undefined;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`유효한 정수가 아닙니다: ${value}`);
  return number;
}
