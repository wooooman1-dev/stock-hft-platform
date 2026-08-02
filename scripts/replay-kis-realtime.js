import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { replayRealtimeResearchFile } from "../server/domain/realtimeResearchReplay.js";

try {
  const options = parseArguments(process.argv.slice(2));
  const result = replayRealtimeResearchFile(options.filePath, {
    horizonsMs: options.horizonsMs,
    evaluatorOptions: options.evaluatorOptions,
  });
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (options.outputPath) {
    writeFileSync(options.outputPath, output, "utf8");
  }
  process.stdout.write(output);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function parseArguments(args) {
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length !== 1) {
    throw new Error(
      "사용법: node scripts/replay-kis-realtime.js <research.jsonl> [--horizons=1000,5000,30000,60000] [--stale-ms=5000] [--max-spread-bps=25] [--min-book-imbalance=0.05] [--min-execution-strength=100] [--max-chase-bps=150] [--output=result.json]",
    );
  }
  const values = Object.fromEntries(args
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const separator = arg.indexOf("=");
      if (separator < 0) return [arg.slice(2), "true"];
      return [arg.slice(2, separator), arg.slice(separator + 1)];
    }));
  return {
    filePath: resolve(positional[0]),
    outputPath: values.output ? resolve(values.output) : null,
    horizonsMs: parseHorizons(values.horizons ?? "1000,5000,30000,60000"),
    evaluatorOptions: {
      staleAfterMs: optionalNumber(values["stale-ms"]),
      maxSpreadBps: optionalNumber(values["max-spread-bps"]),
      minimumBookImbalance: optionalNumber(values["min-book-imbalance"]),
      minimumExecutionStrength: optionalNumber(values["min-execution-strength"]),
      maximumRealtimeChaseBps: optionalNumber(values["max-chase-bps"]),
    },
  };
}

function parseHorizons(value) {
  const horizons = String(value)
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0);
  if (horizons.length === 0) {
    throw new Error("--horizons에는 양의 정수를 하나 이상 지정해야 합니다.");
  }
  return horizons;
}

function optionalNumber(value) {
  if (value === undefined || value === "") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`유효한 숫자가 아닙니다: ${value}`);
  return number;
}
