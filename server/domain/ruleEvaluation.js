// 신호 데이터셋(signalDataset.js)으로 진입 규칙과 청산 정책의 비용 차감 후 기대수익을 평가한다.
//
// 규칙은 "행 → 진입 여부" 순수 함수, 청산은 보유시간·손절/익절·트레일링 정책이다. 개별 손실
// 사례가 아니라 같은 기준으로 수백~수천 건을 비교하고, 앞쪽 날짜로 고른 규칙이 뒤쪽 날짜에서도
// 통하는지(학습/검증 분할)와 날마다 안정적인지를 함께 본다(2026-10-07).

import { SIGNAL_PATH_STEP_MS } from "./signalDataset.js";

const STEPS_PER_MINUTE = 60_000 / SIGNAL_PATH_STEP_MS;

export const DEFAULT_COST_BPS = 23;

// 반환: 비용 차감 전 수익률(bp)과 청산 사유. 경로가 비어 있어 판단할 수 없으면 null.
export function simulateExit(path, policy) {
  const limit = Math.min(path.length, Math.round(policy.minutes * STEPS_PER_MINUTE));
  let lastKnown = null;
  let peak = 0;
  for (let index = 0; index < limit; index += 1) {
    const value = path[index];
    if (value === null || value === undefined) continue;
    lastKnown = value;
    if (policy.type === "bracket") {
      if (value <= -policy.stopBps) return { gross: value, reason: "STOP" };
      if (value >= policy.targetBps) return { gross: policy.targetBps, reason: "TARGET" };
    } else if (policy.type === "trailing") {
      if (value <= -policy.stopBps) return { gross: value, reason: "STOP" };
      if (value > peak) peak = value;
      if (peak >= policy.armBps && value < peak) return { gross: value, reason: "TRAIL" };
    }
  }
  return lastKnown === null ? null : { gross: lastKnown, reason: "TIME" };
}

export function summarizeTrades(trades) {
  const count = trades.length;
  if (count === 0) return { count: 0 };
  const nets = trades.map((trade) => trade.net).sort((a, b) => a - b);
  const mean = nets.reduce((sum, value) => sum + value, 0) / count;
  const variance = count > 1
    ? nets.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (count - 1)
    : 0;
  const byDay = new Map();
  for (const trade of trades) {
    const entry = byDay.get(trade.day) ?? { count: 0, sum: 0 };
    entry.count += 1;
    entry.sum += trade.net;
    byDay.set(trade.day, entry);
  }
  const dayMeans = [...byDay.values()].map((entry) => entry.sum / entry.count);
  return {
    count,
    meanNetBps: round(mean),
    medianNetBps: round(nets[count >> 1]),
    winRate: trades.filter((trade) => trade.net > 0).length / count,
    tStat: variance > 0 ? round(mean / Math.sqrt(variance / count)) : null,
    days: byDay.size,
    positiveDayRatio: dayMeans.filter((value) => value > 0).length / dayMeans.length,
  };
}

export function evaluateRule(rows, {
  name,
  select,
  exit,
  costBps = DEFAULT_COST_BPS,
  dedupMs = 600_000,
  trainRatio = 0.6,
}) {
  const ordered = [...rows].sort((a, b) => a.ts - b.ts);
  const lastBySymbol = new Map();
  const trades = [];
  for (const row of ordered) {
    if (!select(row)) continue;
    const last = lastBySymbol.get(row.symbol);
    if (last !== undefined && row.ts - last < dedupMs) continue;
    const result = simulateExit(row.path, exit);
    if (result === null) continue;
    lastBySymbol.set(row.symbol, row.ts);
    trades.push({ ts: row.ts, day: row.day, symbol: row.symbol, gross: result.gross, net: result.gross - costBps, reason: result.reason });
  }
  const days = [...new Set(trades.map((trade) => trade.day))].sort();
  const splitIndex = Math.max(1, Math.ceil(days.length * trainRatio));
  const trainDays = new Set(days.slice(0, splitIndex));
  return {
    name,
    exit,
    all: summarizeTrades(trades),
    train: summarizeTrades(trades.filter((trade) => trainDays.has(trade.day))),
    test: summarizeTrades(trades.filter((trade) => !trainDays.has(trade.day))),
    trades,
  };
}

// 적용 기준(계획 C): 검증 구간 순기대수익 > 0, 표본 100건 이상, 날짜별 60% 이상 양수.
export function passesAdoptionBar(result) {
  const test = result.test;
  return test.count >= 100 && test.meanNetBps > 0 && result.all.positiveDayRatio >= 0.6;
}

function round(value) {
  return Math.round(value * 10) / 10;
}
