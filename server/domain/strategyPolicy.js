import { normalizeStrategySettings } from "./strategySettings.js";

export function evaluateAutoStrategy({
  metrics,
  account,
  settings,
  now,
  lastOrderAt,
  lastPrice,
  positionRiskState,
}) {
  const normalized = normalizeStrategySettings(settings);
  const currentTime = Number(now);
  const previousOrderTime = Number(lastOrderAt);
  if (!Number.isFinite(currentTime) || !Number.isFinite(previousOrderTime)) {
    throw new TypeError("자동전략 평가에는 유효한 현재시각과 마지막 주문시각이 필요합니다.");
  }

  const positionQuantity = Number(account?.position?.quantity ?? 0);
  if (positionQuantity > 0) {
    const protectiveExit = evaluatePositionRiskExit({
      account,
      settings: normalized,
      now: currentTime,
      lastPrice,
      positionRiskState,
    });
    if (protectiveExit) return protectiveExit;
  }

  if (currentTime - previousOrderTime < normalized.cooldownMs) return null;

  const confidence = Number(metrics?.confidence ?? 0);
  const spreadTicks = Number(metrics?.spreadTicks ?? Infinity);
  const signal = metrics?.signal;

  if (
    signal === "BUY"
    && confidence >= normalized.entryMinimumConfidence
    && spreadTicks <= normalized.maximumSpreadTicks
    && positionQuantity === 0
  ) {
    return {
      side: "BUY",
      quantity: normalized.orderQuantity,
      reason: "ENTRY_SIGNAL",
    };
  }

  if (
    signal === "SELL"
    && confidence >= normalized.exitMinimumConfidence
    && positionQuantity > 0
  ) {
    const sellableQuantity = resolveSellableQuantity(account, positionQuantity);
    if (sellableQuantity <= 0) return null;
    return {
      side: "SELL",
      quantity: sellableQuantity,
      reason: "EXIT_SIGNAL",
    };
  }

  return null;
}

export function evaluatePositionRiskExit({
  account,
  settings,
  now,
  lastPrice,
  positionRiskState,
}) {
  const normalized = normalizeStrategySettings(settings);
  const positionQuantity = Number(account?.position?.quantity ?? 0);
  if (positionQuantity <= 0) return null;

  const quantity = resolveSellableQuantity(account, positionQuantity);
  if (quantity <= 0) return null;

  const enabled = normalized.stopLossBps !== null
    || normalized.takeProfitBps !== null
    || normalized.trailingStopBps !== null
    || normalized.maxHoldingMs !== null;
  if (!enabled) return null;

  const averagePrice = Number(account?.position?.averagePrice);
  const currentPrice = Number(lastPrice);
  if (!Number.isFinite(averagePrice) || averagePrice <= 0) return null;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return null;

  const returnBps = ((currentPrice - averagePrice) / averagePrice) * 10_000;
  if (normalized.stopLossBps !== null && returnBps <= -normalized.stopLossBps) {
    return riskExitIntent(quantity, "STOP_LOSS", { returnBps });
  }

  const peakPrice = Number(positionRiskState?.peakPrice);
  if (
    normalized.trailingStopBps !== null
    && Number.isFinite(peakPrice)
    && peakPrice > 0
  ) {
    const drawdownFromPeakBps = ((peakPrice - currentPrice) / peakPrice) * 10_000;
    if (drawdownFromPeakBps >= normalized.trailingStopBps) {
      return riskExitIntent(quantity, "TRAILING_STOP", {
        returnBps,
        drawdownFromPeakBps,
        peakPrice,
      });
    }
  }

  if (normalized.takeProfitBps !== null && returnBps >= normalized.takeProfitBps) {
    return riskExitIntent(quantity, "TAKE_PROFIT", { returnBps });
  }

  const openedAt = Number(positionRiskState?.openedAt);
  const currentTime = Number(now);
  if (
    normalized.maxHoldingMs !== null
    && Number.isFinite(openedAt)
    && Number.isFinite(currentTime)
    && currentTime >= openedAt
  ) {
    const heldMs = currentTime - openedAt;
    if (heldMs >= normalized.maxHoldingMs) {
      return riskExitIntent(quantity, "MAX_HOLDING_TIME", { returnBps, heldMs });
    }
  }

  return null;
}

function resolveSellableQuantity(account, positionQuantity) {
  const sellable = Number(account?.sellableQuantity);
  if (Number.isInteger(sellable) && sellable >= 0) {
    return Math.min(positionQuantity, sellable);
  }
  return positionQuantity;
}

function riskExitIntent(quantity, reason, diagnostics) {
  return {
    side: "SELL",
    quantity,
    reason,
    diagnostics,
  };
}
