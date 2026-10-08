import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateAutoStrategy,
  evaluatePositionRiskExit,
} from "../domain/strategyPolicy.js";
import {
  DEFAULT_STRATEGY_SETTINGS,
  normalizeStrategySettings,
  StrategySettingsError,
} from "../domain/strategySettings.js";

const account = ({ quantity = 10, averagePrice = 10_000, sellableQuantity = quantity } = {}) => ({
  position: { quantity, averagePrice },
  sellableQuantity,
});

const riskState = ({ openedAt = 1_000, peakPrice = 10_000, belowPeakSince = null } = {}) => ({
  quantity: 10,
  openedAt,
  peakPrice,
  belowPeakSince,
});

test("risk exits are disabled by default and old persisted settings gain OFF fields", () => {
  const migrated = normalizeStrategySettings({
    entryMinimumConfidence: 61,
    exitMinimumConfidence: 55,
    maximumSpreadTicks: 3,
    orderQuantity: 7,
    cooldownMs: 10_000,
  });
  assert.equal(migrated.stopLossBps, null);
  assert.equal(migrated.takeProfitBps, null);
  assert.equal(migrated.trailingStopBps, null);
  assert.equal(migrated.maxHoldingMs, null);
  assert.equal(evaluatePositionRiskExit({
    account: account(),
    settings: migrated,
    now: 999_999,
    lastPrice: 1,
    positionRiskState: riskState({ peakPrice: 20_000 }),
  }), null);
});

test("risk exit settings accept null and reject unsafe boundaries", () => {
  assert.deepEqual(normalizeStrategySettings({
    stopLossBps: 1,
    takeProfitBps: 10_000,
    trailingStopBps: null,
    maxHoldingMs: 1_000,
  }), {
    ...DEFAULT_STRATEGY_SETTINGS,
    stopLossBps: 1,
    takeProfitBps: 10_000,
    trailingStopBps: null,
    maxHoldingMs: 1_000,
  });
  assert.throws(
    () => normalizeStrategySettings({ stopLossBps: 0 }),
    (error) => error instanceof StrategySettingsError && /손절률/.test(error.message),
  );
  assert.throws(() => normalizeStrategySettings({ takeProfitBps: 10_001 }), /익절률/);
  assert.throws(() => normalizeStrategySettings({ trailingStopBps: 1.5 }), /트레일링/);
  assert.throws(() => normalizeStrategySettings({ maxHoldingMs: 999 }), /최대 보유시간/);
});

test("stop loss triggers exactly at the configured loss for the complete position", () => {
  const intent = evaluatePositionRiskExit({
    account: account({ quantity: 10, averagePrice: 10_000, sellableQuantity: 6 }),
    settings: { ...DEFAULT_STRATEGY_SETTINGS, stopLossBps: 100 },
    now: 2_000,
    lastPrice: 9_900,
    positionRiskState: riskState(),
  });
  assert.equal(intent.side, "SELL");
  assert.equal(intent.quantity, 10);
  assert.equal(intent.reason, "STOP_LOSS");
  assert.ok(intent.diagnostics.returnBps <= -100);
});

test("take profit triggers exactly at the configured gain", () => {
  const intent = evaluatePositionRiskExit({
    account: account(),
    settings: { ...DEFAULT_STRATEGY_SETTINGS, takeProfitBps: 250 },
    now: 2_000,
    lastPrice: 10_250,
    positionRiskState: riskState(),
  });
  assert.equal(intent.reason, "TAKE_PROFIT");
  assert.equal(intent.quantity, 10);
});

test("trailing stop uses peak price rather than average entry price", () => {
  const intent = evaluatePositionRiskExit({
    account: account({ averagePrice: 9_000 }),
    settings: { ...DEFAULT_STRATEGY_SETTINGS, trailingStopBps: 100 },
    now: 2_000,
    lastPrice: 9_900,
    positionRiskState: riskState({ peakPrice: 10_000 }),
  });
  assert.equal(intent.reason, "TRAILING_STOP");
  assert.ok(intent.diagnostics.returnBps > 0);
  assert.ok(intent.diagnostics.drawdownFromPeakBps >= 100);
});

// 2026-09-23: "0.7% 다 빠질 때까지 왜 기다리냐" 지적에 따라 트레일링 스톱을
// "진입가 대비 문턱만큼 오른 적이 있으면(armed) 그 뒤 신고점을 못 찍고 조금만
// 빠져도 폭 안 따지고 바로 판다"로 바꿨다.
test("트레일링 스톱은 진입가 대비 문턱만큼 오르기 전에는(armed 전) 하락에도 발동하지 않는다", () => {
  const intent = evaluatePositionRiskExit({
    account: account({ averagePrice: 10_000 }),
    settings: { ...DEFAULT_STRATEGY_SETTINGS, trailingStopBps: 100 },
    now: 2_000,
    // 고점이 진입가 대비 50bp밖에 안 올랐다(문턱 100bp 미달) — 아직 armed 전.
    lastPrice: 10_040,
    positionRiskState: riskState({ peakPrice: 10_050 }),
  });
  assert.equal(intent, null, "문턱을 넘어본 적이 없으면 하락 중이어도 매도하면 안 된다");
});

test("트레일링 스톱은 armed된 뒤에는 신고점 경신 중에는 발동하지 않는다", () => {
  const intent = evaluatePositionRiskExit({
    account: account({ averagePrice: 10_000 }),
    settings: { ...DEFAULT_STRATEGY_SETTINGS, trailingStopBps: 100 },
    now: 2_000,
    // 현재가가 곧 신고점이다(peakPrice와 동일) — 계속 오르는 중이므로 매도 금지.
    lastPrice: 10_150,
    positionRiskState: riskState({ peakPrice: 10_150 }),
  });
  assert.equal(intent, null, "신고점을 계속 경신하는 동안은 매도하면 안 된다");
});

test("트레일링 스톱은 armed된 뒤 첫 하락 틱에서 폭과 무관하게 즉시 발동한다", () => {
  const intent = evaluatePositionRiskExit({
    account: account({ averagePrice: 10_000 }),
    settings: { ...DEFAULT_STRATEGY_SETTINGS, trailingStopBps: 100 },
    now: 2_000,
    // 고점(10,150, 진입가 대비 150bp로 armed) 대비 딱 1원(1bp도 안 됨)만 빠졌다.
    lastPrice: 10_149,
    positionRiskState: riskState({ peakPrice: 10_150 }),
  });
  assert.equal(intent.reason, "TRAILING_STOP");
  assert.ok(intent.diagnostics.drawdownFromPeakBps < 1, "폭이 문턱(100bp)보다 훨씬 작아도 발동해야 한다");
});

// 2026-09-23: 실시간 틱(observeTick)으로 더 자주 확인할수록 찰나의 호가 흔들림
// 하나에 바로 팔릴 위험이 커진다 — trailingConfirmMs는 "고점 밑으로 내려온 상태가
// 이만큼 유지돼야 진짜 하락으로 인정"하는 debounce다.
test("trailingConfirmMs 설정 시, 고점 밑으로 내려온 지 얼마 안 됐으면 아직 발동하지 않는다", () => {
  const intent = evaluatePositionRiskExit({
    account: account({ averagePrice: 10_000 }),
    settings: { ...DEFAULT_STRATEGY_SETTINGS, trailingStopBps: 100, trailingConfirmMs: 1_500 },
    now: 12_000,
    lastPrice: 10_149,
    // 11_000시각에 처음 고점 밑으로 내려왔다 — 지금(12_000)까지 1000ms밖에 안 지났다.
    positionRiskState: riskState({ peakPrice: 10_150, belowPeakSince: 11_000 }),
  });
  assert.equal(intent, null, "확인 시간(1500ms)이 아직 안 지났으면 팔면 안 된다");
});

test("trailingConfirmMs 설정 시, 확인 시간이 지나면 그제서야 발동한다", () => {
  const intent = evaluatePositionRiskExit({
    account: account({ averagePrice: 10_000 }),
    settings: { ...DEFAULT_STRATEGY_SETTINGS, trailingStopBps: 100, trailingConfirmMs: 1_500 },
    now: 12_600,
    lastPrice: 10_149,
    // 11_000시각에 처음 고점 밑으로 내려왔다 — 지금(12_600)까지 1600ms 지났다.
    positionRiskState: riskState({ peakPrice: 10_150, belowPeakSince: 11_000 }),
  });
  assert.equal(intent.reason, "TRAILING_STOP");
  assert.equal(intent.diagnostics.belowPeakMs, 1_600);
});

test("maximum holding time triggers at the exact boundary", () => {
  const settings = { ...DEFAULT_STRATEGY_SETTINGS, maxHoldingMs: 5_000 };
  assert.equal(evaluatePositionRiskExit({
    account: account(),
    settings,
    now: 5_999,
    lastPrice: 10_000,
    positionRiskState: riskState({ openedAt: 1_000 }),
  }), null);
  const intent = evaluatePositionRiskExit({
    account: account(),
    settings,
    now: 6_000,
    lastPrice: 10_000,
    positionRiskState: riskState({ openedAt: 1_000 }),
  });
  assert.equal(intent.reason, "MAX_HOLDING_TIME");
  assert.equal(intent.diagnostics.heldMs, 5_000);
});

test("protective exits bypass entry cooldown", () => {
  const intent = evaluateAutoStrategy({
    metrics: { signal: "HOLD", confidence: 0, spreadTicks: 1 },
    account: account(),
    settings: { ...DEFAULT_STRATEGY_SETTINGS, stopLossBps: 100, cooldownMs: 600_000 },
    now: 2_000,
    lastOrderAt: 1_999,
    lastPrice: 9_800,
    positionRiskState: riskState(),
  });
  assert.equal(intent.reason, "STOP_LOSS");
});

test("protective exit priority is stop loss then trailing then take profit then holding time", () => {
  const intent = evaluatePositionRiskExit({
    account: account({ averagePrice: 10_000 }),
    settings: {
      ...DEFAULT_STRATEGY_SETTINGS,
      stopLossBps: 50,
      trailingStopBps: 50,
      takeProfitBps: 1,
      maxHoldingMs: 1_000,
    },
    now: 5_000,
    lastPrice: 9_900,
    positionRiskState: riskState({ openedAt: 1_000, peakPrice: 10_100 }),
  });
  assert.equal(intent.reason, "STOP_LOSS");
});

test("signal exits request the complete open position", () => {
  assert.deepEqual(evaluateAutoStrategy({
    metrics: { signal: "SELL", confidence: 80, spreadTicks: 10 },
    account: account({ quantity: 10, sellableQuantity: 4 }),
    settings: { ...DEFAULT_STRATEGY_SETTINGS, exitMinimumConfidence: 70 },
    now: 20_000,
    lastOrderAt: 0,
    lastPrice: 10_000,
    positionRiskState: riskState(),
  }), { side: "SELL", quantity: 10, reason: "EXIT_SIGNAL" });
});
