import { PaperTrader } from "./paperTrader.js";

const COMMAND_EVENT = "BROKER_ORDER_COMMAND";
const RESULT_EVENT = "BROKER_ORDER_RESULT";
const FILL_EVENT = "BROKER_FILL_OBSERVED";

// 리스크 한도가 비교 결과를 왜곡하지 않도록, 체결 매칭 로직만 재사용하기 위해 사실상 무제한으로 둔다.
const COMPARISON_LIMITS = Object.freeze({
  maxOrderQuantity: 1_000_000_000,
  maxPositionQuantity: 1_000_000_000,
  maxPositionNotional: Number.MAX_SAFE_INTEGER,
  dailyLossLimit: Number.MAX_SAFE_INTEGER,
});

const RECENT_COMPARISON_LIMIT = 50;

/**
 * 주문 제출 시점에 캡처된 KIS 10단계 호가 스냅샷을 내부 PaperTrader 매칭 엔진에 그대로 통과시켜
 * 가상 체결가·체결량을 계산하고, 이후 KIS가 보고한 실제 체결(BROKER_FILL_OBSERVED)과 비교한다.
 * 예측 기능이 아니라 두 체결모델의 차이를 진단하기 위한 사후 비교 리포트다.
 */
export function computeFillModelComparison(events, { now = Date.now } = {}) {
  const submitCommands = (events ?? []).filter((event) => event.type === COMMAND_EVENT
    && event.payload?.operation === "SUBMIT"
    && event.payload?.orderBookSnapshot);

  const acceptedResultByClientOrderId = new Map();
  for (const event of events ?? []) {
    if (event.type !== RESULT_EVENT) continue;
    const payload = event.payload ?? {};
    if (payload.operation !== "SUBMIT" || String(payload.status ?? "").toUpperCase() !== "ACCEPTED") continue;
    acceptedResultByClientOrderId.set(payload.clientOrderId, payload.result ?? {});
  }

  const latestFillByOrderKey = new Map();
  for (const event of events ?? []) {
    if (event.type !== FILL_EVENT) continue;
    const payload = event.payload ?? {};
    const key = fillKey(payload.orderOrganizationNumber, payload.orderNumber);
    const previous = latestFillByOrderKey.get(key);
    if (!previous || number(payload.cumulativeExecutedQuantity) > number(previous.cumulativeExecutedQuantity)) {
      latestFillByOrderKey.set(key, payload);
    }
  }

  const comparisons = submitCommands.map((event) => buildComparisonEntry(event.payload, {
    acceptedResultByClientOrderId,
    latestFillByOrderKey,
  }));

  const comparable = comparisons.filter((item) => item.comparable);
  const priceDeltas = comparable
    .map((item) => item.priceDeltaBps)
    .filter((value) => Number.isFinite(value));

  return {
    generatedAt: now(),
    totalSubmittedWithSnapshot: submitCommands.length,
    comparableCount: comparable.length,
    averagePriceDeltaBps: priceDeltas.length > 0
      ? priceDeltas.reduce((sum, value) => sum + value, 0) / priceDeltas.length
      : null,
    maxAbsolutePriceDeltaBps: priceDeltas.length > 0
      ? Math.max(...priceDeltas.map((value) => Math.abs(value)))
      : null,
    recentComparisons: comparisons.slice(-RECENT_COMPARISON_LIMIT),
  };
}

function buildComparisonEntry(command, { acceptedResultByClientOrderId, latestFillByOrderKey }) {
  const request = command.request ?? {};
  const brokerResult = acceptedResultByClientOrderId.get(command.clientOrderId) ?? null;
  const orderNumber = text(brokerResult?.orderNumber);
  const orderOrganizationNumber = text(brokerResult?.orderOrganizationNumber);
  const brokerFillEvent = orderNumber
    ? latestFillByOrderKey.get(fillKey(orderOrganizationNumber, orderNumber))
    : null;

  const internalFill = simulateInternalFill(command);
  const brokerFill = brokerFillEvent ? {
    filledQuantity: number(brokerFillEvent.cumulativeExecutedQuantity),
    averagePrice: number(brokerFillEvent.executedPrice),
    observedAt: brokerFillEvent.capturedAt ?? null,
  } : null;

  const comparable = Boolean(
    internalFill
    && internalFill.filledQuantity > 0
    && brokerFill
    && brokerFill.filledQuantity > 0
    && brokerFill.averagePrice > 0,
  );

  return {
    clientOrderId: command.clientOrderId,
    orderNumber,
    symbol: text(request.symbol),
    side: text(request.side),
    type: text(request.type),
    requestedQuantity: number(request.quantity),
    submittedAt: command.timestamp,
    orderBookCapturedAt: command.orderBookSnapshot?.capturedAt ?? null,
    internalFill,
    brokerFill,
    comparable,
    priceDeltaBps: comparable ? priceDeltaBps(internalFill.averagePrice, brokerFill.averagePrice) : null,
    quantityDelta: comparable ? internalFill.filledQuantity - brokerFill.filledQuantity : null,
    note: !brokerResult
      ? "증권사 접수 결과를 확인할 수 없습니다."
      : !brokerFill
        ? "KIS 체결 관찰 대기 중입니다."
        : null,
  };
}

function simulateInternalFill(command) {
  const snapshot = command.orderBookSnapshot;
  const request = command.request ?? {};
  if (!snapshot) return null;
  try {
    const trader = new PaperTrader(Number.MAX_SAFE_INTEGER, {
      now: () => command.timestamp,
      limits: COMPARISON_LIMITS,
    });
    const order = trader.submit({
      side: request.side,
      type: request.type,
      quantity: number(request.quantity),
      limitPrice: request.limitPrice ?? null,
      tickSize: snapshot.tickSize,
      referencePrice: snapshot.referencePrice,
      source: "FILL_MODEL_COMPARISON",
      killSwitch: false,
      clientOrderId: `comparison-${command.clientOrderId}`,
      timestamp: command.timestamp,
      book: { bids: snapshot.bids, asks: snapshot.asks },
    });
    return {
      status: order.status,
      filledQuantity: order.filledQuantity,
      averagePrice: order.filledQuantity > 0 ? order.averageFilledPrice : null,
    };
  } catch {
    return null;
  }
}

function priceDeltaBps(internalPrice, brokerPrice) {
  if (!Number.isFinite(internalPrice) || !Number.isFinite(brokerPrice) || brokerPrice <= 0) return null;
  return ((internalPrice - brokerPrice) / brokerPrice) * 10_000;
}

function fillKey(organizationNumber, orderNumber) {
  return `${text(organizationNumber) ?? "*"}:${text(orderNumber) ?? ""}`;
}

function text(value) {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result || null;
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}
