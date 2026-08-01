import assert from "node:assert/strict";
import test from "node:test";
import {
  KIS_MODE_PROD_READ_ONLY,
  loadKisConfiguration,
} from "../integrations/kis/kisConfig.js";

function env(overrides = {}) {
  return {
    PULSEHFT_KIS_MODE: KIS_MODE_PROD_READ_ONLY,
    PULSEHFT_KIS_APP_KEY: " env-app-key ",
    PULSEHFT_KIS_APP_SECRET: " env-app-secret ",
    ...overrides,
  };
}

test("KIS production read-only credentials load directly from environment", () => {
  const config = loadKisConfiguration("Z:/missing/kis-prod-read-only.json", { env: env() });

  assert.equal(config.enabled, true);
  assert.equal(config.mode, KIS_MODE_PROD_READ_ONLY);
  assert.equal(config.environment, "PROD");
  assert.equal(config.credentialSource, "ENV");
  assert.equal(config.credentialsPath, null);
  assert.equal(config.appKey, "env-app-key");
  assert.equal(config.appSecret, "env-app-secret");
});

test("KIS environment credentials require both key and secret", () => {
  assert.throws(
    () => loadKisConfiguration("Z:/missing/kis-prod-read-only.json", {
      env: env({ PULSEHFT_KIS_APP_SECRET: "" }),
    }),
    (error) => error.code === "KIS_CREDENTIALS_INVALID"
      && /PULSEHFT_KIS_APP_KEY/.test(error.message)
      && /PULSEHFT_KIS_APP_SECRET/.test(error.message),
  );
});

test("KIS production read-only mode rejects account environment variables", () => {
  assert.throws(
    () => loadKisConfiguration("Z:/missing/kis-prod-read-only.json", {
      env: env({ PULSEHFT_KIS_ACCOUNT_NUMBER: "12345678" }),
    }),
    (error) => error.code === "KIS_CREDENTIALS_INVALID"
      && /PULSEHFT_KIS_ACCOUNT_NUMBER/.test(error.message),
  );
});

test("KIS environment credentials take precedence over a missing local JSON file", () => {
  const config = loadKisConfiguration("Z:/missing/kis-prod-read-only.json", { env: env() });
  assert.equal(config.credentialSource, "ENV");
});
