import { normalizeStrategySettings } from "./strategySettings.js";

export function evaluateAutoStrategy({
  metrics,
  account,
  settings,
  now,
  lastOrderAt,
}) {
  const normalized = normalizeStrategySettings(settings);
  const currentTime = Number(now);
  const previousOrderTime = Number(lastOrderAt);
  if (!Number.isFinite(currentTime) || !Number.isFinite(previousOrderTime)) {
    throw new TypeError("자동전략 평가에는 유효한 현재시각과 마지막 주문시각이 필요합니다.");
  }
  if (currentTime - previousOrderTime < normalized.cooldownMs) return null;

  const positionQuantity = Number(account?.position?.quantity ?? 0);
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
    return {
      side: "SELL",
      quantity: positionQuantity,
      reason: "EXIT_SIGNAL",
    };
  }

  return null;
}
