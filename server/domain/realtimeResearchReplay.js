import { evaluateRealtimeConfirmation } from "./realtimeConfirmationEngine.js";
import { readRealtimeResearchEvents } from "./realtimeResearchJournal.js";

const DEFAULT_HORIZONS_MS = Object.freeze([1_000, 5_000, 30_000, 60_000]);

export function replayRealtimeResearchFile(filePath, options = {}) {
  return replayRealtimeResearchEvents(readRealtimeResearchEvents(filePath), options);
}

export function replayRealtimeResearchEvents(events, {
  evaluator = evaluateRealtimeConfirmation,
  evaluatorOptions = {},
  horizonsMs = DEFAULT_HORIZONS_MS,
} = {}) {
  if (!Array.isArray(events)) throw new TypeError("events는 배열이어야 합니다.");
  if (typeof evaluator !== "function") throw new TypeError("evaluator는 함수여야 합니다.");
  const horizons = normalizeHorizons(horizonsMs);
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const candidates = new Map();
  const snapshots = new Map();
  const states = new Map();
  const transitions = [];
  const signals = [];
  const lastPrices = new Map();
  const connection = { state: "DISCONNECTED", connected: false };
  let scannerRefreshCount = 0;
  let marketDataEventCount = 0;

  for (const event of ordered) {
    if (event.type === "SCANNER_REFRESH") {
      scannerRefreshCount += 1;
      const next = new Map();
      for (const candidate of event.payload.candidates ?? []) {
        if (candidate?.symbol) next.set(String(candidate.symbol), candidate);
      }
      for (const symbol of candidates.keys()) {
        if (!next.has(symbol)) {
          transition(symbol, states.get(symbol) ?? null, "DROPPED", event, {
            reason: "추천 후보에서 제외",
          });
          states.set(symbol, "DROPPED");
        }
      }
      candidates.clear();
      for (const [symbol, candidate] of next) candidates.set(symbol, candidate);
      for (const symbol of candidates.keys()) evaluateSymbol(symbol, event.timestamp, event);
      continue;
    }

    if (event.type === "REALTIME_CONNECTION_STATUS") {
      connection.state = event.payload.state ?? connection.state;
      connection.connected = Boolean(event.payload.connected);
      for (const symbol of candidates.keys()) evaluateSymbol(symbol, event.timestamp, event);
      continue;
    }

    if (event.type === "REALTIME_MARKET_DATA") {
      marketDataEventCount += 1;
      const snapshot = event.payload.snapshot ?? event.payload;
      const symbol = String(snapshot?.symbol ?? "");
      if (!symbol) continue;
      const normalized = {
        ...snapshot,
        connected: snapshot.connected ?? connection.connected,
        connectionState: snapshot.connectionState ?? connection.state,
      };
      snapshots.set(symbol, normalized);
      const price = numberOrNull(normalized.trade?.currentPrice);
      if (price !== null) {
        lastPrices.set(symbol, { timestamp: event.timestamp, price });
        settleSignals(symbol, event.timestamp, price);
      }
      evaluateSymbol(symbol, event.timestamp, event);
    }
  }

  const stateCounts = {};
  for (const item of transitions) {
    stateCounts[item.toState] = (stateCounts[item.toState] ?? 0) + 1;
  }
  const perSymbol = {};
  for (const item of transitions) {
    const entry = perSymbol[item.symbol] ?? {
      transitionCount: 0,
      entryReadyCount: 0,
      firstEntryReadyAt: null,
      lastEntryReadyAt: null,
      states: {},
    };
    entry.transitionCount += 1;
    entry.states[item.toState] = (entry.states[item.toState] ?? 0) + 1;
    if (item.toState === "ENTRY_READY") {
      entry.entryReadyCount += 1;
      entry.firstEntryReadyAt ??= item.timestamp;
      entry.lastEntryReadyAt = item.timestamp;
    }
    perSymbol[item.symbol] = entry;
  }

  const outcomes = horizons.map((horizonMs) => summarizeHorizon(signals, horizonMs));
  const firstTimestamp = ordered[0]?.timestamp ?? null;
  const lastTimestamp = ordered.at(-1)?.timestamp ?? null;
  return {
    model: "OBSERVATIONAL_NO_FILL_MODEL",
    automaticOrderConnected: false,
    eventCount: ordered.length,
    scannerRefreshCount,
    marketDataEventCount,
    firstTimestamp,
    lastTimestamp,
    durationMs: firstTimestamp !== null && lastTimestamp !== null
      ? Math.max(0, lastTimestamp - firstTimestamp)
      : 0,
    symbolCount: new Set([
      ...candidates.keys(),
      ...transitions.map((item) => item.symbol),
    ]).size,
    transitionCount: transitions.length,
    stateCounts,
    perSymbol,
    signals: signals.map((signal) => ({
      ...signal,
      outcomes: { ...signal.outcomes },
    })),
    outcomeSummary: outcomes,
    warnings: [
      "체결 가능 수량, 호가 소진, 슬리피지, 수수료, 세금, 부분체결을 반영하지 않은 관찰형 결과입니다.",
      "ENTRY_READY 임계값의 수익성을 입증하지 않으며 주문 실행에 사용할 수 없습니다.",
    ],
  };

  function evaluateSymbol(symbol, timestamp, sourceEvent) {
    const candidate = candidates.get(symbol);
    if (!candidate) return;
    const snapshot = snapshots.get(symbol) ?? {
      symbol,
      connectionState: connection.state,
      connected: connection.connected,
      orderBook: null,
      trade: null,
      latestAt: null,
    };
    const evaluation = evaluator(candidate, snapshot, {
      ...evaluatorOptions,
      now: timestamp,
    });
    const previous = states.get(symbol) ?? null;
    if (previous !== evaluation.state) {
      transition(symbol, previous, evaluation.state, sourceEvent, {
        reasons: evaluation.reasons,
        metrics: evaluation.metrics,
      });
      states.set(symbol, evaluation.state);
      if (evaluation.state === "ENTRY_READY") {
        const entryPrice = numberOrNull(evaluation.metrics?.currentPrice)
          ?? lastPrices.get(symbol)?.price
          ?? null;
        signals.push({
          symbol,
          timestamp,
          entryPrice,
          outcomes: Object.fromEntries(
            horizons.map((horizon) => [String(horizon), null]),
          ),
        });
      }
    }
  }

  function transition(symbol, fromState, toState, event, detail) {
    transitions.push({
      symbol,
      fromState,
      toState,
      timestamp: event.timestamp,
      sourceSequence: event.sequence,
      sourceType: event.type,
      ...detail,
    });
  }

  function settleSignals(symbol, timestamp, price) {
    for (const signal of signals) {
      if (signal.symbol !== symbol || signal.entryPrice === null) continue;
      for (const horizon of horizons) {
        const key = String(horizon);
        if (signal.outcomes[key] !== null) continue;
        if (timestamp < signal.timestamp + horizon) continue;
        signal.outcomes[key] = {
          observedAt: timestamp,
          price,
          grossReturnBps: round(
            ((price - signal.entryPrice) / signal.entryPrice) * 10_000,
            3,
          ),
        };
      }
    }
  }
}

function summarizeHorizon(signals, horizonMs) {
  const values = signals
    .map((signal) => signal.outcomes[String(horizonMs)]?.grossReturnBps)
    .filter(Number.isFinite);
  const sorted = [...values].sort((a, b) => a - b);
  return {
    horizonMs,
    signalCount: signals.length,
    observedCount: values.length,
    missingCount: signals.length - values.length,
    averageGrossReturnBps: values.length
      ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 3)
      : null,
    medianGrossReturnBps: values.length ? round(median(sorted), 3) : null,
    positiveRatePercent: values.length
      ? round((values.filter((value) => value > 0).length / values.length) * 100, 2)
      : null,
    minimumGrossReturnBps: values.length ? sorted[0] : null,
    maximumGrossReturnBps: values.length ? sorted.at(-1) : null,
  };
}

function normalizeHorizons(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("horizonsMs는 비어 있지 않은 배열이어야 합니다.");
  }
  return [...new Set(value.map((item) => {
    const number = Number(item);
    if (!Number.isInteger(number) || number <= 0) {
      throw new TypeError("horizon은 양의 정수여야 합니다.");
    }
    return number;
  }))].sort((a, b) => a - b);
}

function median(values) {
  const middle = Math.floor(values.length / 2);
  return values.length % 2
    ? values[middle]
    : (values[middle - 1] + values[middle]) / 2;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits) {
  const power = 10 ** digits;
  return Math.round(value * power) / power;
}
