// 하루치 자동매매 결과를 원인 분석용으로 묶는다: 청산 사유별 성적, 진입 유형별 성적, 보유 중
// 최대 상승/하락(MFE/MAE), 진입 필터 탈락 사유 분포. 매매 건수는 하루 몇 건뿐이라 이 리포트만으로
// 규칙을 바꾸지 말고, 신호 단위 평가(scripts/evaluate-rules.js)와 같이 본다(2026-10-07).

const KST_OFFSET_MS = 9 * 3_600_000;

export function kstDay(timestamp) {
  return new Date(Number(timestamp) + KST_OFFSET_MS).toISOString().slice(0, 10);
}

// events: 실행 저널 이벤트 전체. trades: computePerformanceReport가 돌려준 실현 거래 목록.
export function buildDailyReport({ events, trades, day }) {
  const commands = new Map();
  const buysBySymbol = new Map();
  const clientIdByOrderNumber = new Map();
  const gateReasons = new Map();
  const gateSymbols = new Set();
  let gateEvents = 0;
  let autoOrders = 0;

  for (const event of events) {
    const payload = event.payload ?? {};
    if (event.type === "BROKER_ORDER_COMMAND" && String(payload.clientOrderId ?? "").startsWith("AUTO:")) {
      commands.set(payload.clientOrderId, payload);
      if (payload.request?.side === "BUY") {
        const list = buysBySymbol.get(payload.request.symbol) ?? [];
        list.push(payload);
        buysBySymbol.set(payload.request.symbol, list);
      }
      if (kstDay(payload.timestamp ?? event.timestamp) === day) autoOrders += 1;
    } else if (event.type === "BROKER_ORDER_RESULT" && payload.result?.orderNumber) {
      clientIdByOrderNumber.set(String(payload.result.orderNumber), payload.clientOrderId);
    } else if (event.type === "AUTO_ENTRY_GATE" && kstDay(event.timestamp) === day) {
      gateEvents += 1;
      for (const item of payload.blocked ?? []) {
        gateReasons.set(item.reason, (gateReasons.get(item.reason) ?? 0) + 1);
        gateSymbols.add(`${item.symbol}:${item.reason}`);
      }
    }
  }

  const dayTrades = trades.filter((trade) => kstDay(trade.closedAt) === day);
  const byExitReason = new Map();
  const byEntryType = new Map();
  const byEntryHour = new Map();
  const detail = [];
  for (const trade of dayTrades) {
    const sell = commands.get(clientIdByOrderNumber.get(String(trade.orderNumber)));
    const exitReason = sell?.reason ?? "UNKNOWN";
    const buy = pickBuyBefore(buysBySymbol.get(trade.symbol), sell?.timestamp ?? trade.closedAt);
    const entryType = buy?.context?.candidate?.type ?? "UNKNOWN";
    const entryHour = buy ? new Date((buy.timestamp) + KST_OFFSET_MS).toISOString().slice(11, 13) : "??";
    const row = {
      symbol: trade.symbol, name: trade.name ?? null, exitReason, entryType, entryHour,
      gross: trade.grossPnl, cost: trade.totalCost, net: trade.netPnl,
      mfeBps: sell?.context?.mfeBps ?? null, maeBps: sell?.context?.maeBps ?? null,
      heldMs: sell?.context?.heldMs ?? null,
      gate: buy?.context?.gate ?? null,
    };
    detail.push(row);
    add(byExitReason, exitReason, row);
    add(byEntryType, entryType, row);
    add(byEntryHour, entryHour, row);
  }

  return {
    day,
    tradeCount: dayTrades.length,
    autoOrders,
    totals: totals(detail),
    byExitReason: toObject(byExitReason),
    byEntryType: toObject(byEntryType),
    byEntryHour: toObject(byEntryHour),
    entryGate: {
      events: gateEvents,
      reasons: Object.fromEntries([...gateReasons.entries()].sort((a, b) => b[1] - a[1])),
      distinctSymbolReasons: gateSymbols.size,
    },
    trades: detail,
  };
}

function pickBuyBefore(list, timestamp) {
  if (!list) return null;
  let best = null;
  for (const buy of list) {
    if (buy.timestamp <= timestamp && (best === null || buy.timestamp > best.timestamp)) best = buy;
  }
  return best;
}

function add(map, key, row) {
  const bucket = map.get(key) ?? { rows: [] };
  bucket.rows.push(row);
  map.set(key, bucket);
}

function toObject(map) {
  return Object.fromEntries([...map.entries()].map(([key, bucket]) => [key, totals(bucket.rows)]));
}

function totals(rows) {
  const count = rows.length;
  const sum = (key) => rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
  const mean = (key) => {
    const values = rows.map((row) => row[key]).filter((value) => value !== null && value !== undefined);
    return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
  };
  return {
    count,
    gross: Math.round(sum("gross")),
    cost: Math.round(sum("cost")),
    net: Math.round(sum("net")),
    wins: rows.filter((row) => row.net > 0).length,
    avgMfeBps: mean("mfeBps"),
    avgMaeBps: mean("maeBps"),
  };
}
