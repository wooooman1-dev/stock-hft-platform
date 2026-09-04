import assert from "node:assert/strict";
import test from "node:test";
import {
  KIS_LIVE_BASE_URL,
  KIS_LIVE_MODE_DISABLED,
  KIS_LIVE_MODE_TRADING,
  loadKisLiveConfiguration,
  publicKisLiveConfiguration,
} from "../integrations/kis/kisLiveConfig.js";
import { loadKisConfiguration } from "../integrations/kis/kisConfig.js";

test("KIS live config is disabled by default", () => {
  const config = loadKisLiveConfiguration(null, { env: {} });
  assert.equal(config.mode, KIS_LIVE_MODE_DISABLED);
  assert.equal(config.enabled, false);
  assert.equal(config.orderEnabled, false);
});

test("KIS live config uses only separate live credentials and stays order-disabled without the second gate", () => {
  const env = {
    PULSEHFT_KIS_LIVE_MODE: "LIVE_TRADING",
    PULSEHFT_KIS_LIVE_APP_KEY: "live-key",
    PULSEHFT_KIS_LIVE_APP_SECRET: "live-secret",
    PULSEHFT_KIS_LIVE_ACCOUNT_NUMBER: "12345678",
    PULSEHFT_KIS_LIVE_ACCOUNT_PRODUCT_CODE: "01",
  };
  const config = loadKisLiveConfiguration(null, { env });
  assert.equal(config.mode, KIS_LIVE_MODE_TRADING);
  assert.equal(config.environment, "LIVE");
  assert.equal(config.baseUrl, KIS_LIVE_BASE_URL);
  assert.equal(config.orderEnabled, false);
  const publicConfig = publicKisLiveConfiguration(config);
  assert.equal(publicConfig.accountNumberMasked, "12****78");
  assert.equal(publicConfig.balanceApiAvailable, true);
  assert.equal(publicConfig.orderApiAvailable, false);
  assert.equal(JSON.stringify(publicConfig).includes("live-secret"), false);
});

test("KIS live config requires the explicit second gate to enable order placement", () => {
  const config = loadKisLiveConfiguration(null, {
    env: {
      PULSEHFT_KIS_LIVE_MODE: "LIVE_TRADING",
      PULSEHFT_KIS_LIVE_APP_KEY: "live-key",
      PULSEHFT_KIS_LIVE_APP_SECRET: "live-secret",
      PULSEHFT_KIS_LIVE_ACCOUNT_NUMBER: "12345678",
      PULSEHFT_KIS_LIVE_ACCOUNT_PRODUCT_CODE: "01",
      PULSEHFT_KIS_LIVE_ORDER_ENABLED: "true",
    },
  });
  assert.equal(config.orderEnabled, true);
  assert.equal(publicKisLiveConfiguration(config).orderApiAvailable, true);
});

test("KIS live config rejects production quote-key reuse", () => {
  assert.throws(() => loadKisLiveConfiguration(null, {
    env: {
      PULSEHFT_KIS_MODE: "PROD_READ_ONLY",
      PULSEHFT_KIS_APP_KEY: "same-key",
      PULSEHFT_KIS_APP_SECRET: "prod-secret",
      PULSEHFT_KIS_LIVE_MODE: "LIVE_TRADING",
      PULSEHFT_KIS_LIVE_APP_KEY: "same-key",
      PULSEHFT_KIS_LIVE_APP_SECRET: "live-secret",
      PULSEHFT_KIS_LIVE_ACCOUNT_NUMBER: "12345678",
      PULSEHFT_KIS_LIVE_ACCOUNT_PRODUCT_CODE: "01",
    },
  }), (error) => error.code === "KIS_LIVE_QUOTE_CREDENTIAL_REUSE");
});

test("KIS live config rejects paper-key reuse (opposite direction from the paper guard)", () => {
  assert.throws(() => loadKisLiveConfiguration(null, {
    env: {
      PULSEHFT_KIS_PAPER_MODE: "PAPER_TRADING",
      PULSEHFT_KIS_PAPER_APP_KEY: "shared-key",
      PULSEHFT_KIS_PAPER_APP_SECRET: "paper-secret",
      PULSEHFT_KIS_PAPER_ACCOUNT_NUMBER: "87654321",
      PULSEHFT_KIS_PAPER_ACCOUNT_PRODUCT_CODE: "01",
      PULSEHFT_KIS_LIVE_MODE: "LIVE_TRADING",
      PULSEHFT_KIS_LIVE_APP_KEY: "shared-key",
      PULSEHFT_KIS_LIVE_APP_SECRET: "live-secret",
      PULSEHFT_KIS_LIVE_ACCOUNT_NUMBER: "12345678",
      PULSEHFT_KIS_LIVE_ACCOUNT_PRODUCT_CODE: "01",
    },
  }), (error) => error.code === "KIS_LIVE_PAPER_CREDENTIAL_REUSE");
});

test("KIS live config validates account format", () => {
  assert.throws(() => loadKisLiveConfiguration(null, {
    env: {
      PULSEHFT_KIS_LIVE_MODE: "LIVE_TRADING",
      PULSEHFT_KIS_LIVE_APP_KEY: "live-key",
      PULSEHFT_KIS_LIVE_APP_SECRET: "live-secret",
      PULSEHFT_KIS_LIVE_ACCOUNT_NUMBER: "1234",
      PULSEHFT_KIS_LIVE_ACCOUNT_PRODUCT_CODE: "01",
    },
  }), (error) => error.code === "KIS_LIVE_CREDENTIALS_INVALID");
});

test("KIS live config defaults the canary limits to the user-approved conservative values", () => {
  const config = loadKisLiveConfiguration(null, {
    env: {
      PULSEHFT_KIS_LIVE_MODE: "LIVE_TRADING",
      PULSEHFT_KIS_LIVE_APP_KEY: "live-key",
      PULSEHFT_KIS_LIVE_APP_SECRET: "live-secret",
      PULSEHFT_KIS_LIVE_ACCOUNT_NUMBER: "12345678",
      PULSEHFT_KIS_LIVE_ACCOUNT_PRODUCT_CODE: "01",
    },
  });
  assert.deepEqual(config.limits, {
    maxOrderQuantity: 1,
    maxOrderValue: 2_000_000,
    maxDailyOrders: 5,
    maxDailyLoss: 20_000,
    maxConsecutiveLosses: 2,
  });
});

test("KIS live config hard-ceilings order quantity at 1 share even if overridden", () => {
  assert.throws(() => loadKisLiveConfiguration(null, {
    env: {
      PULSEHFT_KIS_LIVE_MODE: "LIVE_TRADING",
      PULSEHFT_KIS_LIVE_APP_KEY: "live-key",
      PULSEHFT_KIS_LIVE_APP_SECRET: "live-secret",
      PULSEHFT_KIS_LIVE_ACCOUNT_NUMBER: "12345678",
      PULSEHFT_KIS_LIVE_ACCOUNT_PRODUCT_CODE: "01",
      PULSEHFT_KIS_LIVE_MAX_ORDER_QUANTITY: "5",
    },
  }), (error) => error.code === "KIS_LIVE_LIMIT_INVALID");
});

test("KIS live config's env var namespace never collides with the read-only quote config's forbidden fields", () => {
  const env = {
    PULSEHFT_KIS_MODE: "PROD_READ_ONLY",
    PULSEHFT_KIS_APP_KEY: "prod-key",
    PULSEHFT_KIS_APP_SECRET: "prod-secret",
    PULSEHFT_KIS_LIVE_MODE: "LIVE_TRADING",
    PULSEHFT_KIS_LIVE_APP_KEY: "live-key",
    PULSEHFT_KIS_LIVE_APP_SECRET: "live-secret",
    PULSEHFT_KIS_LIVE_ACCOUNT_NUMBER: "12345678",
    PULSEHFT_KIS_LIVE_ACCOUNT_PRODUCT_CODE: "01",
  };
  assert.doesNotThrow(() => loadKisConfiguration(null, { env }));
  assert.doesNotThrow(() => loadKisLiveConfiguration(null, { env }));
});
