import { createReadStream, createWriteStream, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createSignalDatasetBuilder } from "../server/domain/signalDataset.js";

// 연구 저널에서 신호 데이터셋(스캐너 스냅샷·ENTRY_READY 전환 + 이후 1시간 가격 경로)을 만든다.
//   node scripts/build-signal-dataset.js [--from 20260921] [--dir <저널 폴더>] [--out <출력 jsonl>]
const args = parseArguments(process.argv.slice(2));
const directory = resolve(args.dir ?? ".pulsehft/realtime-research");
const output = resolve(args.out ?? ".pulsehft/analysis/signal-dataset.jsonl");
const files = readdirSync(directory)
  .filter((name) => name.endsWith(".jsonl") && name.slice(0, 8) >= args.from)
  .sort();

const builder = createSignalDatasetBuilder();
for (const name of files) {
  const lines = createInterface({ input: createReadStream(join(directory, name), { encoding: "utf8" }) });
  for await (const line of lines) builder.ingestLine(line);
  process.stderr.write(`읽음 ${name} ${JSON.stringify(builder.stats())}\n`);
}
const rows = builder.finish();
mkdirSync(dirname(output), { recursive: true });
const stream = createWriteStream(output);
for (const row of rows) stream.write(`${JSON.stringify(row)}\n`);
await new Promise((resolveStream) => stream.end(resolveStream));
const entryReady = rows.filter((row) => row.kind === "ENTRY_READY").length;
process.stdout.write(`행 ${rows.length}개 (스냅샷 ${rows.length - entryReady}, ENTRY_READY ${entryReady}) → ${output}\n`);

function parseArguments(argv) {
  const parsed = { from: "00000000", dir: null, out: null };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (key === "--from") parsed.from = argv[index + 1];
    else if (key === "--dir") parsed.dir = argv[index + 1];
    else if (key === "--out") parsed.out = argv[index + 1];
    else throw new Error(`알 수 없는 인자: ${key}`);
  }
  return parsed;
}
