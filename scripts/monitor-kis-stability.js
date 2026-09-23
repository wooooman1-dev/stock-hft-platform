import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_DURATION_MS = 3 * 60 * 60 * 1_000;
const DEFAULT_INTERVAL_MS = 10_000;
const MAX_INCIDENTS = 500;

export function parseMonitorArguments(argv = process.argv.slice(2), env = process.env) {
  const options = {
    baseUrl: env.PULSEHFT_STABILITY_BASE_URL ?? "http://127.0.0.1:8787",
    durationMs: numberFromEnvironment(
      env.PULSEHFT_STABILITY_DURATION_MINUTES,
      DEFAULT_DURATION_MS / 60_000,
    ) * 60_000,
    intervalMs: numberFromEnvironment(
      env.PULSEHFT_STABILITY_INTERVAL_SECONDS,
      DEFAULT_INTERVAL_MS / 1_000,
    ) * 1_000,
    outputDirectory: env.PULSEHFT_STABILITY_OUTPUT_DIR ?? ".pulsehft",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--base-url") {
      options.baseUrl = requiredValue(argument, value);
      index += 1;
    } else if (argument === "--duration-minutes") {
      options.durationMs = positiveNumber(requiredValue(argument, value), argument) * 60_000;
      index += 1;
    } else if (argument === "--interval-seconds") {
      options.intervalMs = positiveNumber(requiredValue(argument, value), argument) * 1_000;
      index += 1;
    } else if (argument === "--output-directory") {
      options.outputDirectory = requiredValue(argument, value);
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      return { ...options, help: true };
    } else {
      throw new Error(`지원하지 않는 인수입니다: ${argument}`);
    }
  }

  const normalizedBaseUrl = new URL(options.baseUrl);
  if (!isLoopbackHost(normalizedBaseUrl.hostname)) {
    throw new Error("안정성 감시 대상은 localhost 또는 loopback 주소여야 합니다.");
  }
  if (options.intervalMs < 1_000) {
    throw new Error("감시 간격은 1초 이상이어야 합니다.");
  }
  if (options.durationMs < options.intervalMs) {
    throw new Error("감시 시간은 감시 간격보다 길어야 합니다.");
  }
  return {
    ...options,
    baseUrl: normalizedBaseUrl.origin,
    outputDirectory: resolve(options.outputDirectory),
  };
}

export async function runKisStabilityMonitor({
  baseUrl,
  durationMs = DEFAULT_DURATION_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  outputDirectory = resolve(".pulsehft"),
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = defaultSleep,
  logger = console,
  signal = null,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch 구현이 필요합니다.");
  if (typeof now !== "function") throw new TypeError("now는 함수여야 합니다.");
  if (typeof sleep !== "function") throw new TypeError("sleep은 함수여야 합니다.");
  if (!Number.isFinite(durationMs) || durationMs < 1_000) throw new TypeError("durationMs가 올바르지 않습니다.");
  if (!Number.isFinite(intervalMs) || intervalMs < 1_000) throw new TypeError("intervalMs가 올바르지 않습니다.");

  const endpoint = new URL(baseUrl ?? "http://127.0.0.1:8787");
  if (!isLoopbackHost(endpoint.hostname)) {
    throw new Error("안정성 감시 대상은 localhost 또는 loopback 주소여야 합니다.");
  }

  mkdirSync(outputDirectory, { recursive: true });
  const startedAt = now();
  const stamp = fileTimestamp(startedAt);
  const samplePath = resolve(outputDirectory, `kis-stability-${stamp}.jsonl`);
  const reportPath = resolve(outputDirectory, `kis-stability-${stamp}.json`);
  const latestReportPath = resolve(outputDirectory, "kis-stability-latest.json");
  const latestSamplesPath = resolve(outputDirectory, "kis-stability-latest.jsonl");
  writeFileSync(samplePath, "", "utf8");
  writeFileSync(latestSamplesPath, "", "utf8");

  const state = createState({ startedAt, durationMs, intervalMs, baseUrl: endpoint.origin });
  let previous = null;
  logger.log(`[KIS 안정성] 읽기 전용 감시 시작: ${Math.round(durationMs / 60_000)}분, ${intervalMs / 1_000}초 간격`);
  logger.log("[KIS 안정성] 주문·정정·취소 API는 호출하지 않습니다.");

  while (now() - startedAt < durationMs && !signal?.aborted) {
    const sampleStartedAt = now();
    const sample = await collectSample({
      baseUrl: endpoint.origin,
      fetchImpl,
      now,
      elapsedMs: Math.max(0, sampleStartedAt - startedAt),
    });
    updateState(state, sample, previous);
    previous = sample;
    appendJsonLine(samplePath, sample);
    appendJsonLine(latestSamplesPath, sample);

    if (shouldLogSample(state, sample)) {
      logger.log(formatProgress(state, sample));
    }
    if (state.criticalFailure) break;

    const elapsed = now() - startedAt;
    const remaining = durationMs - elapsed;
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining), signal);
  }

  const endedAt = now();
  const report = finalizeReport(state, previous, endedAt, Boolean(signal?.aborted));
  writeJson(reportPath, report);
  writeJson(latestReportPath, report);
  logger.log(`[KIS 안정성] ${report.status}: ${report.summary}`);
  logger.log(`[KIS 안정성] 보고서: ${latestReportPath}`);
  logger.log(`[KIS 안정성] 원본 샘플: ${latestSamplesPath}`);
  return report;
}

async function collectSample({ baseUrl, fetchImpl, now, elapsedMs }) {
  const sampledAt = now();
  const requests = [
    ["health", "/health"],
    ["snapshot", "/api/snapshot"],
    ["kis", "/api/kis/status"],
    ["paper", "/api/kis/paper/status"],
  ];
  const responses = await Promise.all(requests.map(async ([name, path]) => {
    const startedAt = now();
    try {
      const response = await fetchImpl(new URL(path, baseUrl), {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }
      return [name, {
        ok: response.ok,
        status: response.status,
        latencyMs: Math.max(0, now() - startedAt),
        body,
        error: response.ok ? null : firstText(body?.error, body?.message, `HTTP ${response.status}`),
      }];
    } catch (error) {
      return [name, {
        ok: false,
        status: null,
        latencyMs: Math.max(0, now() - startedAt),
        body: null,
        error: errorMessage(error),
      }];
    }
  }));
  const result = Object.fromEntries(responses);
  const health = result.health.body ?? {};
  const snapshot = result.snapshot.body ?? {};
  const kis = result.kis.body ?? {};
  const paper = result.paper.body ?? {};
  const realtime = kis.realtime ?? {};
  const reconciliation = paper.service?.reconciliation ?? {};
  const system = snapshot.system ?? {};

  return {
    sampledAt,
    elapsedMs,
    endpoints: Object.fromEntries(Object.entries(result).map(([name, item]) => [name, {
      ok: item.ok,
      status: item.status,
      latencyMs: item.latencyMs,
      error: item.error,
    }])),
    server: {
      healthy: result.health.ok && health.status === "ok",
      mode: health.mode ?? null,
    },
    market: {
      symbol: snapshot.symbol ?? null,
      source: system.marketDataSource ?? null,
      feedState: system.feedState ?? realtime.state ?? null,
      connected: Boolean(system.feedConnected ?? realtime.connected),
      stale: Boolean(system.feedStale),
      latencyMs: finiteOrNull(system.latencyMs ?? realtime.freshestDataAgeMs),
      lastEventAt: finiteOrNull(system.lastEventAt ?? realtime.lastMessageAt),
      lastConnectedAt: finiteOrNull(realtime.lastConnectedAt),
      lastDisconnectedAt: finiteOrNull(realtime.lastDisconnectedAt),
      reconnectAttempt: finiteOrZero(realtime.reconnectAttempt),
      lastError: realtime.lastError ?? system.marketError ?? null,
      marketError: system.marketError ?? null,
    },
    paper: {
      enabled: Boolean(paper.enabled ?? health.kisPaper?.enabled),
      mode: paper.mode ?? health.kisPaper?.mode ?? null,
      killSwitch: Boolean(paper.service?.killSwitch ?? system.killSwitch),
      unknownResult: Boolean(paper.service?.unknownResult ?? system.unknownResult),
      automaticStrategyConnected: Boolean(
        paper.service?.automaticStrategyConnected
        || health.kisPaper?.automaticStrategyConnected
        || system.automaticStrategyConnected
        || system.autoPaperTrading
        || system.recommendationAutomaticOrderConnected
      ),
      executionModel: system.executionModel ?? null,
      accountError: system.accountError ?? null,
      orderHistoryError: system.orderHistoryError ?? null,
    },
    reconciliation: {
      status: reconciliation.status ?? null,
      rawStatus: reconciliation.rawStatus ?? reconciliation.status ?? null,
      blocked: Boolean(reconciliation.blocked),
      latched: Boolean(reconciliation.latched),
      issueCount: finiteOrZero(reconciliation.summary?.issueCount),
      pendingCount: finiteOrZero(reconciliation.summary?.pendingCount),
      issues: Array.isArray(reconciliation.issues)
        ? reconciliation.issues.slice(0, 10).map((item) => ({
          code: item?.code ?? null,
          message: item?.message ?? null,
        }))
        : [],
    },
  };
}

function createState({ startedAt, durationMs, intervalMs, baseUrl }) {
  return {
    startedAt,
    durationMs,
    intervalMs,
    baseUrl,
    sampleCount: 0,
    successfulSampleCount: 0,
    endpointFailureCount: 0,
    consecutiveEndpointFailureCount: 0,
    maximumConsecutiveEndpointFailures: 0,
    realtimeConnectedSamples: 0,
    realtimeDisconnectedSamples: 0,
    staleSamples: 0,
    restFallbackSamples: 0,
    notConnectedSamples: 0,
    reconnectEvents: 0,
    disconnectEvents: 0,
    reconciliationCounts: {},
    killSwitchSamples: 0,
    unknownResultSamples: 0,
    accountErrorSamples: 0,
    orderHistoryErrorSamples: 0,
    marketErrorSamples: 0,
    automaticOrderViolationSamples: 0,
    transitions: [],
    incidents: [],
    criticalFailure: false,
    lastLoggedAt: null,
  };
}

function updateState(state, sample, previous) {
  state.sampleCount += 1;
  const allEndpointsOk = Object.values(sample.endpoints).every((item) => item.ok);
  if (allEndpointsOk) {
    state.successfulSampleCount += 1;
    state.consecutiveEndpointFailureCount = 0;
  } else {
    state.endpointFailureCount += Object.values(sample.endpoints).filter((item) => !item.ok).length;
    state.consecutiveEndpointFailureCount += 1;
    state.maximumConsecutiveEndpointFailures = Math.max(
      state.maximumConsecutiveEndpointFailures,
      state.consecutiveEndpointFailureCount,
    );
    recordIncident(state, sample, "ENDPOINT_FAILURE", Object.entries(sample.endpoints)
      .filter(([, item]) => !item.ok)
      .map(([name, item]) => `${name}:${item.error ?? item.status ?? "실패"}`)
      .join(", "));
  }

  if (sample.market.connected) state.realtimeConnectedSamples += 1;
  else state.realtimeDisconnectedSamples += 1;
  if (sample.market.stale) state.staleSamples += 1;
  if (sample.market.source === "KIS_REST") state.restFallbackSamples += 1;
  if (sample.market.source === "KIS_NOT_CONNECTED") state.notConnectedSamples += 1;

  const reconciliationStatus = sample.reconciliation.status ?? "UNKNOWN";
  state.reconciliationCounts[reconciliationStatus] = (state.reconciliationCounts[reconciliationStatus] ?? 0) + 1;
  if (sample.paper.killSwitch) state.killSwitchSamples += 1;
  if (sample.paper.unknownResult) state.unknownResultSamples += 1;
  if (sample.paper.accountError) state.accountErrorSamples += 1;
  if (sample.paper.orderHistoryError) state.orderHistoryErrorSamples += 1;
  if (sample.market.marketError) state.marketErrorSamples += 1;
  if (sample.paper.automaticStrategyConnected) state.automaticOrderViolationSamples += 1;

  if (previous) {
    transition(state, sample, "market.connected", previous.market.connected, sample.market.connected);
    transition(state, sample, "market.feedState", previous.market.feedState, sample.market.feedState);
    transition(state, sample, "market.source", previous.market.source, sample.market.source);
    transition(state, sample, "market.stale", previous.market.stale, sample.market.stale);
    transition(state, sample, "reconciliation.status", previous.reconciliation.status, sample.reconciliation.status);
    if (sample.market.lastDisconnectedAt && sample.market.lastDisconnectedAt !== previous.market.lastDisconnectedAt) {
      state.disconnectEvents += 1;
      recordIncident(state, sample, "WEBSOCKET_DISCONNECTED", `lastDisconnectedAt=${sample.market.lastDisconnectedAt}`);
    }
    if (sample.market.lastConnectedAt && sample.market.lastConnectedAt !== previous.market.lastConnectedAt) {
      state.reconnectEvents += 1;
      recordIncident(state, sample, "WEBSOCKET_CONNECTED", `lastConnectedAt=${sample.market.lastConnectedAt}`);
    }
  }

  if (sample.paper.automaticStrategyConnected) {
    state.criticalFailure = true;
    recordIncident(state, sample, "AUTOMATIC_ORDER_CONNECTION", "자동주문 연결이 감지되어 감시를 즉시 중단했습니다.");
  }
  if (sample.paper.unknownResult) {
    state.criticalFailure = true;
    recordIncident(state, sample, "UNKNOWN_ORDER_RESULT", "증권사 주문 결과 불명확 상태가 감지되었습니다.");
  }
  if (sample.reconciliation.status === "MISMATCH" || sample.reconciliation.latched) {
    state.criticalFailure = true;
    recordIncident(state, sample, "RECONCILIATION_MISMATCH", sample.reconciliation.issues
      .map((item) => `${item.code ?? "-"}:${item.message ?? "-"}`)
      .join(" | "));
  }
  if (state.consecutiveEndpointFailureCount >= 3) {
    state.criticalFailure = true;
    recordIncident(state, sample, "SERVER_UNAVAILABLE", "연속 3회 이상 상태 조회에 실패했습니다.");
  }
}

function finalizeReport(state, lastSample, endedAt, interrupted) {
  const finalReconciliation = lastSample?.reconciliation?.status ?? null;
  const critical = state.criticalFailure
    || state.automaticOrderViolationSamples > 0
    || state.unknownResultSamples > 0
    || (state.reconciliationCounts.MISMATCH ?? 0) > 0
    || Boolean(lastSample?.reconciliation?.latched)
    || state.successfulSampleCount === 0;
  const warning = interrupted
    || state.endpointFailureCount > 0
    || state.realtimeDisconnectedSamples > 0
    || state.staleSamples > 0
    || state.restFallbackSamples > 0
    || state.notConnectedSamples > 0
    || (state.reconciliationCounts.PENDING ?? 0) > 0
    || (state.reconciliationCounts.UNAVAILABLE ?? 0) > 0
    || finalReconciliation !== "CONSISTENT";
  const status = critical ? "FAIL" : warning ? "WARN" : "PASS";
  return {
    status,
    summary: status === "PASS"
      ? "WebSocket·REST·모의계좌 대조 상태가 감시 시간 동안 정상입니다."
      : status === "WARN"
        ? "중대한 주문 안전 위반은 없지만 연결 또는 조회 상태 변동이 기록되었습니다."
        : "자동주문 연결, 주문 결과 불명확, 계좌 불일치 또는 지속적인 서버 장애가 감지되었습니다.",
    readOnly: true,
    automaticOrderConnected: false,
    startedAt: state.startedAt,
    endedAt,
    actualDurationMs: Math.max(0, endedAt - state.startedAt),
    requestedDurationMs: state.durationMs,
    intervalMs: state.intervalMs,
    interrupted,
    baseUrl: state.baseUrl,
    counters: {
      samples: state.sampleCount,
      successfulSamples: state.successfulSampleCount,
      endpointFailures: state.endpointFailureCount,
      maximumConsecutiveEndpointFailures: state.maximumConsecutiveEndpointFailures,
      realtimeConnectedSamples: state.realtimeConnectedSamples,
      realtimeDisconnectedSamples: state.realtimeDisconnectedSamples,
      staleSamples: state.staleSamples,
      restFallbackSamples: state.restFallbackSamples,
      notConnectedSamples: state.notConnectedSamples,
      reconnectEvents: state.reconnectEvents,
      disconnectEvents: state.disconnectEvents,
      reconciliation: state.reconciliationCounts,
      killSwitchSamples: state.killSwitchSamples,
      unknownResultSamples: state.unknownResultSamples,
      accountErrorSamples: state.accountErrorSamples,
      orderHistoryErrorSamples: state.orderHistoryErrorSamples,
      marketErrorSamples: state.marketErrorSamples,
      automaticOrderViolationSamples: state.automaticOrderViolationSamples,
    },
    finalState: lastSample ? {
      sampledAt: lastSample.sampledAt,
      market: lastSample.market,
      paper: lastSample.paper,
      reconciliation: lastSample.reconciliation,
    } : null,
    transitions: state.transitions,
    incidents: state.incidents,
  };
}

function transition(state, sample, field, before, after) {
  if (before === after) return;
  if (state.transitions.length < MAX_INCIDENTS) {
    state.transitions.push({ sampledAt: sample.sampledAt, elapsedMs: sample.elapsedMs, field, before, after });
  }
}

function recordIncident(state, sample, type, detail) {
  if (state.incidents.length >= MAX_INCIDENTS) return;
  const previous = state.incidents.at(-1);
  if (previous?.type === type && previous?.detail === detail) {
    previous.lastAt = sample.sampledAt;
    previous.count += 1;
    return;
  }
  state.incidents.push({
    type,
    detail: detail || null,
    firstAt: sample.sampledAt,
    lastAt: sample.sampledAt,
    count: 1,
  });
}

function shouldLogSample(state, sample) {
  if (state.sampleCount === 1 || state.criticalFailure) return true;
  if (state.lastLoggedAt === null || sample.sampledAt - state.lastLoggedAt >= 60_000) {
    state.lastLoggedAt = sample.sampledAt;
    return true;
  }
  return false;
}

function formatProgress(state, sample) {
  const minutes = (sample.elapsedMs / 60_000).toFixed(1);
  const realtime = sample.market.connected ? "WS 연결" : `WS ${sample.market.feedState ?? "미연결"}`;
  return `[KIS 안정성] ${minutes}분 · ${realtime} · ${sample.market.source ?? "-"} · 대조 ${sample.reconciliation.status ?? "-"} · 샘플 ${state.sampleCount}`;
}

function appendJsonLine(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "a" });
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fileTimestamp(timestamp) {
  return new Date(timestamp).toISOString().replace(/[:.]/g, "-");
}

function numberFromEnvironment(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return positiveNumber(value, "환경변수");
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name}은 0보다 큰 숫자여야 합니다.`);
  return number;
}

function requiredValue(argument, value) {
  if (!value || value.startsWith("--")) throw new Error(`${argument} 값이 필요합니다.`);
  return value;
}

function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function defaultSleep(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function printHelp() {
  console.log(`PulseHFT KIS 장시간 안정성 감시\n\n사용법:\n  npm run monitor:kis:stability -- [옵션]\n\n옵션:\n  --duration-minutes <분>   기본 180분\n  --interval-seconds <초>   기본 10초\n  --base-url <URL>          기본 http://127.0.0.1:8787\n  --output-directory <경로> 기본 .pulsehft\n\n이 스크립트는 상태 조회용 GET 요청만 사용하며 주문·정정·취소 요청을 보내지 않습니다.`);
}

async function main() {
  const options = parseMonitorArguments();
  if (options.help) return printHelp();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const report = await runKisStabilityMonitor({ ...options, signal: controller.signal });
  if (report.status === "FAIL") process.exitCode = 1;
  else if (report.interrupted) process.exitCode = 130;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[KIS 안정성] 실패: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
