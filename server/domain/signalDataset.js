// 연구 저널(스캐너 스냅샷 + 실시간 틱)에서 "신호 → 이후 가격 경로" 데이터셋을 만든다.
//
// 자동매매 규칙이 실제로 돈이 되는지는 하루 몇 건의 체결이 아니라, 같은 기록에서 뽑은 수천 건의
// 신호와 그 뒤 가격 경로로 따져야 한다(2026-10-07). 이 모듈은 순수 계산만 한다 — 파일 읽기와
// 출력은 scripts/build-signal-dataset.js가 맡는다.

const KST_OFFSET_MS = 9 * 3_600_000;
const PATH_STEP_MS = 30_000;

export const DEFAULT_DATASET_OPTIONS = Object.freeze({
  // 스캐너 스냅샷을 종목당 이 간격으로만 표본으로 쓴다(15초마다 나오는 걸 전부 쓰면 중복이 너무 많다).
  sampleIntervalMs: 60_000,
  // 신호 이후 가격 경로를 이 시간만큼 30초 간격으로 기록한다.
  pathMinutes: 60,
  // 시작 시각의 틱이 이 시간 넘게 비어 있으면 그 지점은 비워 둔다.
  maxTickGapMs: 60_000,
});

export function createSignalDatasetBuilder(options = {}) {
  const config = { ...DEFAULT_DATASET_OPTIONS, ...options };
  const ticks = new Map(); // symbol -> { ts: number[], px: number[] }
  const lastTickSecond = new Map();
  const lastSampleAt = new Map();
  const points = []; // 경로를 아직 안 붙인 신호 지점

  function ingestLine(line) {
    const isTick = line.includes('"REALTIME_MARKET_DATA"');
    const isScan = !isTick && line.includes('"SCANNER_REFRESH"');
    const isTransition = !isTick && !isScan
      && line.includes('"REALTIME_STATE_TRANSITION"') && line.includes('"toState":"ENTRY_READY"');
    if (!isTick && !isScan && !isTransition) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    ingestEvent(event);
  }

  function ingestEvent(event) {
    if (!event || typeof event !== "object") return;
    if (event.type === "REALTIME_MARKET_DATA") return ingestTick(event);
    if (event.type === "SCANNER_REFRESH") return ingestScan(event);
    if (event.type === "REALTIME_STATE_TRANSITION" && event.payload?.toState === "ENTRY_READY") {
      return ingestTransition(event);
    }
  }

  function ingestTick(event) {
    const snapshot = event.payload?.snapshot;
    const symbol = snapshot?.symbol;
    const price = Number(snapshot?.trade?.currentPrice);
    if (!symbol || !(price > 0)) return;
    const second = Math.floor(event.timestamp / 1000);
    if (lastTickSecond.get(symbol) === second) return;
    lastTickSecond.set(symbol, second);
    let series = ticks.get(symbol);
    if (!series) ticks.set(symbol, (series = { ts: [], px: [] }));
    series.ts.push(event.timestamp);
    series.px.push(price);
  }

  function ingestScan(event) {
    const candidates = event.payload?.candidates ?? event.payload?.snapshot?.candidates;
    if (!Array.isArray(candidates)) return;
    for (const candidate of candidates) {
      const symbol = candidate?.symbol;
      const price = Number(candidate?.realtime?.metrics?.currentPrice ?? candidate?.currentPrice);
      if (!symbol || !(price > 0)) continue;
      const last = lastSampleAt.get(symbol);
      if (last !== undefined && event.timestamp - last < config.sampleIntervalMs) continue;
      lastSampleAt.set(symbol, event.timestamp);
      points.push({ kind: "SNAPSHOT", ts: event.timestamp, symbol, price, ...candidateFeatures(candidate) });
    }
  }

  function ingestTransition(event) {
    const payload = event.payload;
    const metrics = payload.metrics ?? {};
    const price = Number(metrics.currentPrice);
    if (!payload.symbol || !(price > 0)) return;
    points.push({
      kind: "ENTRY_READY", ts: event.timestamp, symbol: payload.symbol, price,
      stage: payload.candidateStage ?? null, score: payload.score ?? null,
      exStr: finite(metrics.executionStrength), vwapExt: finite(metrics.vwapExtensionBps),
      spreadBps: finite(metrics.spreadBps), book: finite(metrics.bookImbalance), rtState: "ENTRY_READY",
    });
  }

  function finish() {
    return points
      .map((point) => attachOutcome(point, ticks.get(point.symbol), config))
      .filter((row) => row !== null);
  }

  return { ingestLine, ingestEvent, finish, stats: () => ({ points: points.length, symbols: ticks.size }) };
}

export function candidateFeatures(candidate) {
  const micro = candidate.microstructure ?? {};
  const metrics = candidate.realtime?.metrics ?? {};
  const high = finite(candidate.price?.high);
  const price = Number(metrics.currentPrice ?? candidate.currentPrice);
  return {
    stage: candidate.stage ?? null,
    type: candidate.candidateType ?? null,
    score: finite(candidate.score),
    chg: finite(candidate.changePercent),
    exStr: finite(metrics.executionStrength ?? candidate.executionStrength),
    vwapExt: finite(metrics.vwapExtensionBps ?? micro.vwapExtensionBps),
    spreadBps: finite(metrics.spreadBps ?? micro.spreadBps),
    book: finite(metrics.bookImbalance ?? micro.bidAskImbalance),
    rtState: candidate.realtime?.state ?? null,
    flowState: candidate.pullbackRerise?.flowState ?? null,
    rerise: candidate.pullbackRerise?.confirmed ?? null,
    dip: finite(candidate.pullbackRerise?.swingDepthBps),
    priorRet: finite(micro.priorReturnBps),
    recentRet: finite(micro.recentReturnBps),
    volRatio: finite(micro.volumeContractionRatio),
    nearHighBps: high && price > 0 ? ((high - price) / high) * 10_000 : null,
    tradingValue: finite(candidate.accumulatedTradingValue),
  };
}

function attachOutcome(point, series, config) {
  if (!series || series.ts.length === 0) return null;
  const steps = Math.floor((config.pathMinutes * 60_000) / PATH_STEP_MS);
  const path = [];
  let known = 0;
  for (let step = 1; step <= steps; step += 1) {
    const price = priceAt(series, point.ts + step * PATH_STEP_MS, config.maxTickGapMs);
    path.push(price === null ? null : round(((price - point.price) / point.price) * 10_000, 1));
    if (price !== null) known += 1;
  }
  // 첫 구간에 틱이 거의 없으면(구독이 안 된 종목 등) 평가할 수 없다.
  if (known < steps / 4) return null;
  const day = new Date(point.ts + KST_OFFSET_MS).toISOString().slice(0, 10);
  const hhmm = new Date(point.ts + KST_OFFSET_MS).toISOString().slice(11, 16);
  return { ...point, day, hhmm, path };
}

function priceAt(series, timestamp, maxGapMs) {
  const { ts, px } = series;
  let low = 0;
  let high = ts.length - 1;
  let index = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (ts[mid] >= timestamp) { index = mid; high = mid - 1; } else low = mid + 1;
  }
  if (index >= 0 && ts[index] - timestamp <= maxGapMs) return px[index];
  // 그 뒤 틱이 멀면 직전 틱(마지막 체결가)을 쓴다.
  const before = index === -1 ? ts.length - 1 : index - 1;
  if (before >= 0 && timestamp - ts[before] <= maxGapMs * 2) return px[before];
  return null;
}

function finite(value) {
  const number = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(number) ? null : number;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export const SIGNAL_PATH_STEP_MS = PATH_STEP_MS;
