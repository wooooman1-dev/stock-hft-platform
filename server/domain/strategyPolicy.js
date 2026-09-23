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
    return {
      side: "SELL",
      quantity: positionQuantity,
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
  if (!Number.isInteger(positionQuantity) || positionQuantity <= 0) return null;

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
    return riskExitIntent(positionQuantity, "STOP_LOSS", { returnBps });
  }

  // 트레일링 스톱: "고점 대비 X% 빠지면 판다"가 아니라 "진입가 대비 X% 이상
  // 오른 적이 있으면(=armed), 그 뒤로 신고점을 하나라도 더 못 찍고 조금이라도
  // 빠지는 순간 폭을 안 따지고 바로 판다"로 바꿨다(2026-09-23). 오르는 동안은
  // 절대 안 팔고(peakPrice가 currentPrice와 함께 계속 갱신되므로 currentPrice
  // < peakPrice가 성립 안 함), 신고점 경신이 멈춘 뒤 첫 하락 틱에서 바로
  // 판다 — "0.7% 다 뺏길 때까지 왜 기다리냐"는 지적에 따른 변경. armed 문턱
  // (trailingStopBps) 자체는 왕복 비용(약 23bp)보다 확실히 위(기본 35bp)로 둬서,
  // 순수 노이즈 구간에서 무장되자마자 바로 파는 걸 막는다.
  const peakPrice = Number(positionRiskState?.peakPrice);
  if (
    normalized.trailingStopBps !== null
    && Number.isFinite(peakPrice)
    && peakPrice > 0
  ) {
    const peakReturnBps = ((peakPrice - averagePrice) / averagePrice) * 10_000;
    const armed = peakReturnBps >= normalized.trailingStopBps;
    if (armed && currentPrice < peakPrice) {
      // trailingConfirmMs(기본 0): 고점 밑으로 내려온 상태가 이만큼 유지돼야
      // 진짜 하락으로 인정한다. 실시간 틱으로 더 자주 확인할수록(observeTick)
      // 찰나의 호가 흔들림 하나에 바로 팔리는 걸 막는 debounce다.
      const belowPeakSince = Number(positionRiskState?.belowPeakSince);
      const belowPeakMs = Number.isFinite(belowPeakSince)
        ? Number(now) - belowPeakSince
        : 0;
      if (belowPeakMs >= normalized.trailingConfirmMs) {
        return riskExitIntent(positionQuantity, "TRAILING_STOP", {
          returnBps,
          peakPrice,
          peakReturnBps,
          belowPeakMs,
          drawdownFromPeakBps: ((peakPrice - currentPrice) / peakPrice) * 10_000,
        });
      }
    }
  }

  if (normalized.takeProfitBps !== null && returnBps >= normalized.takeProfitBps) {
    return riskExitIntent(positionQuantity, "TAKE_PROFIT", { returnBps });
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
      return riskExitIntent(positionQuantity, "MAX_HOLDING_TIME", { returnBps, heldMs });
    }
  }

  return null;
}

function riskExitIntent(quantity, reason, diagnostics) {
  return {
    side: "SELL",
    quantity,
    reason,
    diagnostics,
  };
}
