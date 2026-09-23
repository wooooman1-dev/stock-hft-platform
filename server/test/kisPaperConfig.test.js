import assert from "node:assert/strict";
import test from "node:test";
import {
  KIS_PAPER_BASE_URL,
  KIS_PAPER_MODE_DISABLED,
  KIS_PAPER_MODE_TRADING,
  loadKisPaperConfiguration,
  publicKisPaperConfiguration,
  KIS_PAPER_LIMIT_BOUNDS,
  normalizeKisPaperLimits,
} from "../integrations/kis/kisPaperConfig.js";

test("KIS paper config is disabled by default", () => {
  const config = loadKisPaperConfiguration(null, { env: {} });
  assert.equal(config.mode, KIS_PAPER_MODE_DISABLED);
  assert.equal(config.enabled, false);
});

test("KIS paper config uses only separate paper credentials", () => {
  const config = loadKisPaperConfiguration(null, {
    env: {
      PULSEHFT_KIS_PAPER_MODE: "PAPER_TRADING",
      PULSEHFT_KIS_PAPER_APP_KEY: "paper-key",
      PULSEHFT_KIS_PAPER_APP_SECRET: "paper-secret",
      PULSEHFT_KIS_PAPER_ACCOUNT_NUMBER: "12345678",
      PULSEHFT_KIS_PAPER_ACCOUNT_PRODUCT_CODE: "01",
    },
  });
  assert.equal(config.mode, KIS_PAPER_MODE_TRADING);
  assert.equal(config.environment, "PAPER");
  assert.equal(config.baseUrl, KIS_PAPER_BASE_URL);
  const publicConfig = publicKisPaperConfiguration(config);
  assert.equal(publicConfig.accountNumberMasked, "12****78");
  assert.equal(JSON.stringify(publicConfig).includes("paper-secret"), false);
});

test("KIS paper config rejects production key reuse", () => {
  assert.throws(() => loadKisPaperConfiguration(null, {
    env: {
      PULSEHFT_KIS_MODE: "PROD_READ_ONLY",
      PULSEHFT_KIS_APP_KEY: "same-key",
      PULSEHFT_KIS_APP_SECRET: "prod-secret",
      PULSEHFT_KIS_PAPER_MODE: "PAPER_TRADING",
      PULSEHFT_KIS_PAPER_APP_KEY: "same-key",
      PULSEHFT_KIS_PAPER_APP_SECRET: "paper-secret",
      PULSEHFT_KIS_PAPER_ACCOUNT_NUMBER: "12345678",
      PULSEHFT_KIS_PAPER_ACCOUNT_PRODUCT_CODE: "01",
    },
  }), (error) => error.code === "KIS_PAPER_PRODUCTION_CREDENTIAL_REUSE");
});

test("KIS paper config validates account format and safety limits", () => {
  assert.throws(() => loadKisPaperConfiguration(null, {
    env: {
      PULSEHFT_KIS_PAPER_MODE: "PAPER_TRADING",
      PULSEHFT_KIS_PAPER_APP_KEY: "paper-key",
      PULSEHFT_KIS_PAPER_APP_SECRET: "paper-secret",
      PULSEHFT_KIS_PAPER_ACCOUNT_NUMBER: "1234",
      PULSEHFT_KIS_PAPER_ACCOUNT_PRODUCT_CODE: "01",
    },
  }), (error) => error.code === "KIS_PAPER_CREDENTIALS_INVALID");

  assert.throws(() => loadKisPaperConfiguration(null, {
    env: {
      PULSEHFT_KIS_PAPER_MODE: "PAPER_TRADING",
      PULSEHFT_KIS_PAPER_APP_KEY: "paper-key",
      PULSEHFT_KIS_PAPER_APP_SECRET: "paper-secret",
      PULSEHFT_KIS_PAPER_ACCOUNT_NUMBER: "12345678",
      PULSEHFT_KIS_PAPER_ACCOUNT_PRODUCT_CODE: "01",
      PULSEHFT_KIS_PAPER_MAX_DAILY_ORDERS: "0",
    },
  }), (error) => error.code === "KIS_PAPER_LIMIT_INVALID");
});

// 검증 중에는 표본 수집 속도와 안전 한도를 자주 조절한다. .env 수정 + 재기동 없이
// 화면에서 바꿀 수 있어야 하므로 부분 입력을 현재 한도 위에 덮어쓴다.
test("한도는 부분 입력을 현재 값 위에 덮어쓴다", () => {
  const current = {
    maxOrderQuantity: 10, maxOrderValue: 1_000_000, maxDailyOrders: 20,
    maxDailyLoss: 100_000, maxConsecutiveLosses: 3,
  };
  const next = normalizeKisPaperLimits({ maxDailyOrders: 200, maxConsecutiveLosses: 0 }, current);
  assert.equal(next.maxDailyOrders, 200);
  assert.equal(next.maxConsecutiveLosses, 0, "0으로 해제할 수 있어야 한다");
  assert.equal(next.maxOrderQuantity, 10, "안 건드린 항목은 유지");
  assert.equal(next.maxOrderValue, 1_000_000);
});

test("빈 값은 현재 한도를 유지한다", () => {
  const current = { maxOrderQuantity: 7, maxOrderValue: 500_000, maxDailyOrders: 30, maxDailyLoss: 50_000, maxConsecutiveLosses: 2 };
  const next = normalizeKisPaperLimits({ maxDailyOrders: "" }, current);
  assert.equal(next.maxDailyOrders, 30);
  assert.equal(next.maxOrderQuantity, 7);
});

test("범위를 벗어난 한도와 알 수 없는 항목을 거부한다", () => {
  for (const input of [
    { maxDailyOrders: 0 },
    { maxDailyOrders: 10_001 },
    { maxOrderQuantity: 1.5 },
    { maxConsecutiveLosses: 101 },
    { maxDailyLoss: -1 },
    { unknownLimit: 1 },
  ]) {
    assert.throws(() => normalizeKisPaperLimits(input, null), `${JSON.stringify(input)}는 거부해야 한다`);
  }
});

test("한도 범위는 화면이 쓸 수 있게 노출된다", () => {
  assert.equal(KIS_PAPER_LIMIT_BOUNDS.maxDailyOrders.maximum, 10_000);
  assert.equal(KIS_PAPER_LIMIT_BOUNDS.maxConsecutiveLosses.minimum, 0);
});
