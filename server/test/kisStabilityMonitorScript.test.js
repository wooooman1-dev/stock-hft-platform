import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseMonitorArguments,
  runKisStabilityMonitor,
} from "../../scripts/monitor-kis-stability.js";

function withTemporaryDirectory(callback) {
  const directory = mkdtempSync(join(tmpdir(), "pulsehft-stability-"));
  return Promise.resolve(callback(directory)).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
  };
}

function bodies({
  connected = true,
  source = "KIS_WEBSOCKET",
  stale = false,
  reconciliationStatus = "CONSISTENT",
  automaticStrategyConnected = false,
  lastConnectedAt = 10_000,
  lastDisconnectedAt = null,
} = {}) {
  return {
    "/health": {
      status: "ok",
      mode: "KIS_MARKET_WITH_PAPER",
      kisPaper: {
        enabled: true,
        mode: "PAPER_TRADING",
        automaticStrategyConnected,
      },
    },
    "/api/snapshot": {
      symbol: "005930",
      system: {
        marketDataSource: source,
        feedState: connected ? "CONNECTED" : "DISCONNECTED",
        feedConnected: connected,
        feedStale: stale,
        latencyMs: stale ? 8_000 : 20,
        lastEventAt: 10_000,
        killSwitch: false,
        unknownResult: false,
        autoPaperTrading: false,
        automaticStrategyConnected,
        recommendationAutomaticOrderConnected: false,
        executionModel: "KIS_PAPER_MANUAL_ONLY",
        marketError: null,
        accountError: null,
        orderHistoryError: null,
      },
    },
    "/api/kis/status": {
      realtime: {
        state: connected ? "CONNECTED" : "DISCONNECTED",
        connected,
        freshestDataAgeMs: stale ? 8_000 : 20,
        lastConnectedAt,
        lastDisconnectedAt,
        lastMessageAt: 10_000,
        reconnectAttempt: connected ? 0 : 1,
        lastError: null,
      },
    },
    "/api/kis/paper/status": {
      enabled: true,
      mode: "PAPER_TRADING",
      service: {
        killSwitch: false,
        unknownResult: false,
        automaticStrategyConnected,
        reconciliation: {
          status: reconciliationStatus,
          rawStatus: reconciliationStatus,
          blocked: reconciliationStatus !== "CONSISTENT",
          latched: reconciliationStatus === "MISMATCH",
          issues: [],
          summary: { issueCount: 0, pendingCount: 0 },
        },
      },
    },
  };
}

function createClock(start = 100_000) {
  let timestamp = start;
  return {
    now: () => timestamp,
    sleep: async (milliseconds) => { timestamp += milliseconds; },
  };
}

function createFetchForSamples(sampleBodies, requests = []) {
  let sampleIndex = -1;
  let active = sampleBodies[0];
  return async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/health") {
      sampleIndex += 1;
      active = sampleBodies[Math.min(sampleIndex, sampleBodies.length - 1)];
    }
    requests.push({ pathname: parsed.pathname, method: options.method ?? "GET" });
    return jsonResponse(active[parsed.pathname]);
  };
}

test("stability monitor records consistent read-only samples and writes PASS report", async () => {
  await withTemporaryDirectory(async (directory) => {
    const clock = createClock();
    const requests = [];
    const report = await runKisStabilityMonitor({
      baseUrl: "http://127.0.0.1:8787",
      durationMs: 2_500,
      intervalMs: 1_000,
      outputDirectory: directory,
      fetchImpl: createFetchForSamples([bodies()], requests),
      now: clock.now,
      sleep: clock.sleep,
      logger: { log() {} },
    });

    assert.equal(report.status, "PASS");
    assert.equal(report.readOnly, true);
    assert.equal(report.counters.samples, 3);
    assert.equal(report.counters.successfulSamples, 3);
    assert.equal(report.counters.reconciliation.CONSISTENT, 3);
    assert.equal(requests.length, 12);
    assert.deepEqual(new Set(requests.map((item) => item.method)), new Set(["GET"]));
    assert.deepEqual(new Set(requests.map((item) => item.pathname)), new Set([
      "/health",
      "/api/snapshot",
      "/api/kis/status",
      "/api/kis/paper/status",
    ]));
    assert.equal(existsSync(join(directory, "kis-stability-latest.json")), true);
    assert.equal(existsSync(join(directory, "kis-stability-latest.jsonl")), true);
    const persisted = JSON.parse(readFileSync(join(directory, "kis-stability-latest.json"), "utf8"));
    assert.equal(persisted.status, "PASS");
  });
});

test("stability monitor records WebSocket disconnect, REST fallback, and recovery as WARN", async () => {
  await withTemporaryDirectory(async (directory) => {
    const clock = createClock();
    const report = await runKisStabilityMonitor({
      baseUrl: "http://localhost:8787",
      durationMs: 2_500,
      intervalMs: 1_000,
      outputDirectory: directory,
      fetchImpl: createFetchForSamples([
        bodies({
          connected: false,
          source: "KIS_REST",
          stale: true,
          lastConnectedAt: null,
          lastDisconnectedAt: 10_000,
        }),
        bodies({
          connected: true,
          source: "KIS_WEBSOCKET",
          stale: false,
          lastConnectedAt: 11_000,
          lastDisconnectedAt: 10_000,
        }),
      ]),
      now: clock.now,
      sleep: clock.sleep,
      logger: { log() {} },
    });

    assert.equal(report.status, "WARN");
    assert.equal(report.counters.realtimeDisconnectedSamples, 1);
    assert.equal(report.counters.restFallbackSamples, 1);
    assert.equal(report.counters.reconnectEvents, 1);
    assert.equal(report.finalState.market.connected, true);
    assert.equal(report.finalState.reconciliation.status, "CONSISTENT");
  });
});

test("stability monitor fails immediately when an automatic order connection is detected", async () => {
  await withTemporaryDirectory(async (directory) => {
    const clock = createClock();
    const report = await runKisStabilityMonitor({
      baseUrl: "http://127.0.0.1:8787",
      durationMs: 10_000,
      intervalMs: 1_000,
      outputDirectory: directory,
      fetchImpl: createFetchForSamples([bodies({ automaticStrategyConnected: true })]),
      now: clock.now,
      sleep: clock.sleep,
      logger: { log() {} },
    });

    assert.equal(report.status, "FAIL");
    assert.equal(report.counters.samples, 1);
    assert.equal(report.counters.automaticOrderViolationSamples, 1);
    assert.equal(report.incidents.some((item) => item.type === "AUTOMATIC_ORDER_CONNECTION"), true);
  });
});

test("monitor arguments reject non-loopback targets and support explicit duration", () => {
  assert.throws(
    () => parseMonitorArguments(["--base-url", "https://example.com"]),
    /loopback/,
  );
  const parsed = parseMonitorArguments([
    "--duration-minutes", "30",
    "--interval-seconds", "5",
    "--base-url", "http://127.0.0.1:8787",
  ], {});
  assert.equal(parsed.durationMs, 30 * 60_000);
  assert.equal(parsed.intervalMs, 5_000);
  assert.equal(parsed.baseUrl, "http://127.0.0.1:8787");
});
