import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  KIS_MODE_DISABLED,
  KIS_MODE_PROD_READ_ONLY,
  loadKisConfiguration,
  publicKisConfiguration,
} from "../integrations/kis/kisConfig.js";
import {
  KisApiError,
  KisProdReadOnlyClient,
} from "../integrations/kis/kisProdReadOnlyClient.js";
import { KisTokenStore } from "../integrations/kis/kisTokenStore.js";

async function withTemporaryDirectory(callback) {
  const directory = mkdtempSync(join(tmpdir(), "pulsehft-kis-"));
  try { return await callback(directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return structuredClone(payload); },
  };
}

function writeCredentials(directory, payload = { appKey: "test-app-key", appSecret: "test-app-secret" }) {
  const filePath = join(directory, "kis-prod-read-only.json");
  writeFileSync(filePath, JSON.stringify(payload), "utf8");
  return filePath;
}

function enabledConfiguration(directory) {
  return loadKisConfiguration(writeCredentials(directory), {
    env: { PULSEHFT_KIS_MODE: KIS_MODE_PROD_READ_ONLY },
  });
}

test("KIS integration stays disabled without reading a credential file by default", () => {
  const config = loadKisConfiguration("Z:/missing/kis-prod-read-only.json", { env: {} });
  assert.equal(config.mode, KIS_MODE_DISABLED);
  assert.equal(config.enabled, false);
  assert.deepEqual(publicKisConfiguration(config), {
    enabled: false,
    configured: false,
    mode: "DISABLED",
    environment: null,
    baseUrlHost: null,
    accountConfigured: false,
    orderApiAvailable: false,
  });
});

test("KIS prod read-only credentials allow only appKey and appSecret", async () => {
  await withTemporaryDirectory((directory) => {
    const invalidPath = writeCredentials(directory, {
      appKey: "key",
      appSecret: "secret",
      accountNumber: "12345678",
    });
    assert.throws(
      () => loadKisConfiguration(invalidPath, {
        env: { PULSEHFT_KIS_MODE: KIS_MODE_PROD_READ_ONLY },
      }),
      (error) => error.code === "KIS_CREDENTIALS_INVALID" && /accountNumber/.test(error.message),
    );

    writeFileSync(invalidPath, JSON.stringify({ appKey: "key", appSecret: "secret" }), "utf8");
    const config = loadKisConfiguration(invalidPath, {
      env: { PULSEHFT_KIS_MODE: KIS_MODE_PROD_READ_ONLY },
    });
    assert.equal(config.environment, "PROD");
    assert.equal(config.baseUrl, "https://openapi.koreainvestment.com:9443");
    assert.equal(publicKisConfiguration(config).orderApiAvailable, false);
  });
});

test("KIS token store persists valid tokens and rejects corrupt token files", async () => {
  await withTemporaryDirectory((directory) => {
    const filePath = join(directory, "kis-prod-token.json");
    const now = () => 1_000_000;
    const store = new KisTokenStore(filePath, { now, safetyWindowMs: 60_000 });
    store.save({
      accessToken: "cached-token",
      tokenType: "Bearer",
      issuedAt: now(),
      expiresAt: now() + 3_600_000,
    });
    assert.equal(store.loadValid().accessToken, "cached-token");
    assert.equal(store.status().state, "VALID");
    const disk = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(disk.accessToken, "cached-token");

    writeFileSync(filePath, "{broken", "utf8");
    assert.throws(
      () => store.load(),
      (error) => error.code === "KIS_TOKEN_READ_FAILED",
    );
  });
});

test("KIS quote client issues a production token and sends the official current-price request", async () => {
  await withTemporaryDirectory(async (directory) => {
    const config = enabledConfiguration(directory);
    const now = () => 1_700_000_000_000;
    const tokenStore = new KisTokenStore(join(directory, "kis-prod-token.json"), { now });
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url: new URL(url), options });
      if (calls.length === 1) {
        return response(200, {
          access_token: "issued-token",
          token_type: "Bearer",
          expires_in: 86_400,
        });
      }
      return response(200, {
        rt_cd: "0",
        msg_cd: "MCA00000",
        msg1: "정상처리 되었습니다.",
        output: {
          rprs_mrkt_kor_name: "KOSPI",
          stck_prpr: "70000",
          prdy_vrss: "1000",
          prdy_vrss_sign: "2",
          prdy_ctrt: "1.45",
          acml_vol: "1234567",
          acml_tr_pbmn: "86419753210",
          stck_oprc: "69000",
          stck_hgpr: "70500",
          stck_lwpr: "68800",
          stck_mxpr: "89700",
          stck_llam: "48300",
          stck_sdpr: "69000",
          aspr_unit: "100",
          cttr: "118.42",
          temp_stop_yn: "N",
        },
      });
    };
    const client = new KisProdReadOnlyClient({ config, tokenStore, fetchImpl, now });
    const quote = await client.getCurrentPrice({ symbol: "005930", market: "UN" });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url.origin, "https://openapi.koreainvestment.com:9443");
    assert.equal(calls[0].url.pathname, "/oauth2/tokenP");
    assert.equal(calls[0].options.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      grant_type: "client_credentials",
      appkey: "test-app-key",
      appsecret: "test-app-secret",
    });

    assert.equal(calls[1].url.pathname, "/uapi/domestic-stock/v1/quotations/inquire-price");
    assert.equal(calls[1].url.searchParams.get("FID_COND_MRKT_DIV_CODE"), "UN");
    assert.equal(calls[1].url.searchParams.get("FID_INPUT_ISCD"), "005930");
    assert.equal(calls[1].options.headers.tr_id, "FHKST01010100");
    assert.equal(calls[1].options.headers.authorization, "Bearer issued-token");
    assert.equal(calls[1].options.headers.custtype, "P");

    assert.deepEqual(quote, {
      source: "KIS",
      mode: "PROD_READ_ONLY",
      environment: "PROD",
      currency: "KRW",
      symbol: "005930",
      market: "UN",
      fetchedAt: now(),
      marketName: "KOSPI",
      currentPrice: 70000,
      previousChange: 1000,
      previousChangeSign: "2",
      changePercent: 1.45,
      accumulatedVolume: 1234567,
      accumulatedTradingValue: 86419753210,
      openPrice: 69000,
      highPrice: 70500,
      lowPrice: 68800,
      upperLimitPrice: 89700,
      lowerLimitPrice: 48300,
      basePrice: 69000,
      askUnit: 100,
      executionStrength: 118.42,
      tradingHalted: false,
    });
    assert.equal(client.status().orderApiAvailable, false);
    assert.equal(client.status().accountConfigured, false);
  });
});

test("KIS quote client reuses an unexpired cached token", async () => {
  await withTemporaryDirectory(async (directory) => {
    const config = enabledConfiguration(directory);
    const now = () => 2_000_000;
    const tokenStore = new KisTokenStore(join(directory, "kis-prod-token.json"), { now });
    tokenStore.save({
      accessToken: "cached-token",
      issuedAt: now(),
      expiresAt: now() + 3_600_000,
    });
    const calls = [];
    const client = new KisProdReadOnlyClient({
      config,
      tokenStore,
      now,
      fetchImpl: async (url, options) => {
        calls.push({ url: new URL(url), options });
        return response(200, { rt_cd: "0", output: { stck_prpr: "70100" } });
      },
    });
    const quote = await client.getCurrentPrice({ symbol: "005930", market: "J" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.pathname, "/uapi/domestic-stock/v1/quotations/inquire-price");
    assert.equal(calls[0].options.headers.authorization, "Bearer cached-token");
    assert.equal(quote.currentPrice, 70100);
  });
});

test("KIS quote client validates symbols and markets before any network request", async () => {
  await withTemporaryDirectory(async (directory) => {
    const config = enabledConfiguration(directory);
    let calls = 0;
    const client = new KisProdReadOnlyClient({
      config,
      tokenStore: new KisTokenStore(join(directory, "kis-prod-token.json")),
      fetchImpl: async () => { calls += 1; return response(500, {}); },
    });
    await assert.rejects(
      () => client.getCurrentPrice({ symbol: "5930", market: "UN" }),
      (error) => error instanceof KisApiError && error.code === "KIS_INVALID_SYMBOL",
    );
    await assert.rejects(
      () => client.getCurrentPrice({ symbol: "005930", market: "INVALID" }),
      (error) => error instanceof KisApiError && error.code === "KIS_INVALID_MARKET",
    );
    assert.equal(calls, 0);
  });
});

test("concurrent KIS token requests are deduplicated", async () => {
  await withTemporaryDirectory(async (directory) => {
    const config = enabledConfiguration(directory);
    const tokenStore = new KisTokenStore(join(directory, "kis-prod-token.json"));
    let calls = 0;
    const client = new KisProdReadOnlyClient({
      config,
      tokenStore,
      fetchImpl: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return response(200, {
          access_token: "single-token",
          token_type: "Bearer",
          expires_in: 86_400,
        });
      },
    });
    const [first, second] = await Promise.all([
      client.getAccessToken(),
      client.getAccessToken(),
    ]);
    assert.equal(first, "single-token");
    assert.equal(second, "single-token");
    assert.equal(calls, 1);
  });
});

test("KIS API failures never include the configured app secret", async () => {
  await withTemporaryDirectory(async (directory) => {
    const config = enabledConfiguration(directory);
    const client = new KisProdReadOnlyClient({
      config,
      tokenStore: new KisTokenStore(join(directory, "kis-prod-token.json")),
      fetchImpl: async () => response(403, { error_description: "접근이 거부되었습니다." }),
    });
    await assert.rejects(
      () => client.getAccessToken(),
      (error) => {
        assert.equal(error.code, "KIS_TOKEN_HTTP_ERROR");
        assert.equal(error.message.includes("test-app-secret"), false);
        return true;
      },
    );
  });
});
