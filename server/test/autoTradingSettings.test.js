import test from "node:test";
import assert from "node:assert/strict";
import {
  assertTradeableConfiguration,
  AutoTradingSettingsError,
  calculateExpectedNetEdgeBps,
  DEFAULT_AUTO_TRADING_SETTINGS,
  loadAutoTradingSettings,
  normalizeAutoTradingSettings,
} from "../domain/autoTradingSettings.js";

const COST = { buyCommissionBps: 1.40527, sellCommissionBps: 1.40527, sellTaxBps: 20 };

test("설계 기본값을 그대로 사용한다", () => {
  const settings = normalizeAutoTradingSettings({});
  assert.equal(settings.enabled, false, "자동매매는 기본으로 꺼져 있어야 한다");
  assert.equal(settings.minimumNetEdgeBps, 50);
  assert.equal(settings.positionSizeRatio, 0.1);
  assert.equal(settings.stopLossBps, 100);
  assert.equal(settings.takeProfitBps, 150);
  assert.equal(settings.trailingStopBps, 100);
  assert.equal(settings.maxHoldingMs, 1_800_000);
  assert.equal(settings.forcedExitTime, "15:15");
  assert.equal(settings.staleQuoteMs, 5_000);
  assert.equal(settings.evaluationIntervalMs, 5_000);
  assert.equal(settings.settlementGraceMs, 180_000);
  assert.equal(settings.haltOnUnknownResult, true);
  assert.equal(settings.haltOnReconciliationMismatch, true);
});

test("모든 항목을 설정으로 덮어쓸 수 있다", () => {
  const settings = normalizeAutoTradingSettings({
    enabled: true,
    minimumNetEdgeBps: 80,
    positionSizeRatio: 0.25,
    entryMinimumConfidence: 70,
    exitMinimumConfidence: 40,
    maximumSpreadTicks: 1,
    cooldownMs: 10_000,
    stopLossBps: 60,
    takeProfitBps: 200,
    trailingStopBps: 40,
    maxHoldingMs: 600_000,
    forcedExitTime: "14:50",
    staleQuoteMs: 3_000,
    haltOnUnknownResult: false,
    haltOnReconciliationMismatch: false,
  });
  assert.equal(settings.enabled, true);
  assert.equal(settings.minimumNetEdgeBps, 80);
  assert.equal(settings.positionSizeRatio, 0.25);
  assert.equal(settings.forcedExitTime, "14:50");
  assert.equal(settings.haltOnUnknownResult, false);
});

test("보호 청산과 강제 청산은 null로 끌 수 있다", () => {
  const settings = normalizeAutoTradingSettings({
    stopLossBps: null,
    takeProfitBps: null,
    trailingStopBps: null,
    maxHoldingMs: null,
    forcedExitTime: null,
  });
  assert.equal(settings.stopLossBps, null);
  assert.equal(settings.takeProfitBps, null);
  assert.equal(settings.forcedExitTime, null);
});

test("환경변수로 설정한다", () => {
  const settings = loadAutoTradingSettings({
    PULSEHFT_AUTO_TRADING_ENABLED: "true",
    PULSEHFT_AUTO_TRADING_MIN_NET_EDGE_BPS: "75",
    PULSEHFT_AUTO_TRADING_POSITION_SIZE_RATIO: "0.2",
    PULSEHFT_AUTO_TRADING_FORCED_EXIT_TIME: "15:00",
  });
  assert.equal(settings.enabled, true);
  assert.equal(settings.minimumNetEdgeBps, 75);
  assert.equal(settings.positionSizeRatio, 0.2);
  assert.equal(settings.forcedExitTime, "15:00");
  // 지정하지 않은 항목은 기본값을 유지한다.
  assert.equal(settings.takeProfitBps, DEFAULT_AUTO_TRADING_SETTINGS.takeProfitBps);
});

test("환경변수가 비어 있으면 기본값을 쓴다", () => {
  const settings = loadAutoTradingSettings({});
  assert.deepEqual({ ...settings }, { ...DEFAULT_AUTO_TRADING_SETTINGS });
});

test("범위를 벗어난 값과 알 수 없는 항목을 거부한다", () => {
  const cases = [
    [{ positionSizeRatio: 0 }, "비율 0"],
    [{ positionSizeRatio: 1.5 }, "비율 1 초과"],
    [{ entryMinimumConfidence: 101 }, "확신도 범위 초과"],
    [{ minimumNetEdgeBps: -1 }, "음수 문턱"],
    [{ maximumSpreadTicks: 1.5 }, "정수 아님"],
    [{ forcedExitTime: "25:00" }, "잘못된 시각"],
    [{ forcedExitTime: "1515" }, "형식 불일치"],
    [{ staleQuoteMs: 0 }, "0 이하"],
    [{ unknownKey: 1 }, "알 수 없는 항목"],
  ];
  for (const [input, label] of cases) {
    assert.throws(
      () => normalizeAutoTradingSettings(input),
      AutoTradingSettingsError,
      `${label}은 거부해야 한다`,
    );
  }
});

test("기대 순익은 고정비용과 실측 스프레드·슬리피지를 모두 뺀다", () => {
  const net = calculateExpectedNetEdgeBps({
    takeProfitBps: 150,
    costModel: COST,
    spreadBps: 25,
    slippageBps: 6.3,
  });
  // 150 - (1.40527 + 1.40527 + 20) - 25 - 6.3
  assert.ok(Math.abs(net - 95.889) < 0.01, `기대 순익 계산이 어긋난다: ${net}`);
});

test("익절 목표가 문턱과 고정비용의 합 이하이면 설정 오류로 거부한다", () => {
  // 문턱 50 + 고정비용 22.81 = 72.81. 익절 70은 어떤 국면에서도 진입 불가.
  assert.throws(
    () => assertTradeableConfiguration(
      normalizeAutoTradingSettings({ takeProfitBps: 70, minimumNetEdgeBps: 50 }),
      COST,
    ),
    (error) => error.code === "AUTO_TRADING_UNREACHABLE_TARGET",
  );
  // 기본값(익절 150, 문턱 50)은 통과해야 한다.
  assert.doesNotThrow(
    () => assertTradeableConfiguration(normalizeAutoTradingSettings({}), COST),
  );
});
