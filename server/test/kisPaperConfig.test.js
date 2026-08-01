import assert from "node:assert/strict";
import test from "node:test";
import {
  KIS_PAPER_BASE_URL,
  KIS_PAPER_MODE_DISABLED,
  KIS_PAPER_MODE_TRADING,
  loadKisPaperConfiguration,
  publicKisPaperConfiguration,
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
