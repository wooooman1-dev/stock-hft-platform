import assert from "node:assert/strict";
import test from "node:test";
import { KisPaperTradingClient } from "../integrations/kis/kisPaperTradingClient.js";

function config() {
  return {
    enabled: true,
    configured: true,
    mode: "PAPER_TRADING",
    environment: "PAPER",
    baseUrl: "https://openapivts.koreainvestment.com:29443",
    appKey: "paper-key",
    appSecret: "paper-secret",
    accountNumber: "12345678",
    accountProductCode: "01",
    limits: {},
  };
}

function tokenStore(token = null) {
  let stored = token;
  return {
    loadValid() { return stored; },
    save(value) { stored = value; return structuredClone(value); },
    status() { return stored ? { state: "VALID", expiresAt: stored.expiresAt } : { state: "MISSING", expiresAt: null }; },
  };
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

test("paper balance uses VTS URL, paper credentials, and VTTC8434R", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return jsonResponse({
      rt_cd: "0",
      output1: [{ pdno: "005930", prdt_name: "삼성전자", hldg_qty: "2", ord_psbl_qty: "2", pchs_avg_pric: "70000", prpr: "71000", evlu_amt: "142000", evlu_pfls_amt: "2000", evlu_pfls_rt: "1.42" }],
      output2: [{ dnca_tot_amt: "900000", evlu_pfls_smtl_amt: "2000", tot_evlu_amt: "1042000" }],
      ctx_area_fk100: "",
      ctx_area_nk100: "",
    });
  };
  const client = new KisPaperTradingClient({
    config: config(),
    tokenStore: tokenStore({ accessToken: "paper-token", issuedAt: 1, expiresAt: Date.now() + 60_000 }),
    fetchImpl,
  });
  const balance = await client.getBalance();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/openapivts\.koreainvestment\.com:29443\/uapi\/domestic-stock\/v1\/trading\/inquire-balance/);
  assert.equal(calls[0].options.headers.tr_id, "VTTC8434R");
  assert.equal(calls[0].options.headers.appkey, "paper-key");
  assert.equal(balance.positions[0].quantity, 2);
  assert.equal(balance.summary.evaluationProfitLoss, 2000);
});

test("paper buy uses latest VTTC0012U and required exchange field", async () => {
  const calls = [];
  const client = new KisPaperTradingClient({
    config: config(),
    tokenStore: tokenStore({ accessToken: "paper-token", issuedAt: 1, expiresAt: Date.now() + 60_000 }),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ rt_cd: "0", output: { KRX_FWDG_ORD_ORGNO: "91234", ODNO: "0000012345", ORD_TMD: "101500" } });
    },
    now: () => 1234,
  });
  const result = await client.submitOrder({
    side: "BUY",
    symbol: "005930",
    type: "LIMIT",
    quantity: 1,
    limitPrice: 70000,
    exchange: "KRX",
  });
  const body = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].options.headers.tr_id, "VTTC0012U");
  assert.equal(body.EXCG_ID_DVSN_CD, "KRX");
  assert.equal(body.ORD_DVSN, "00");
  assert.equal(body.ORD_UNPR, "70000");
  assert.equal(result.orderNumber, "0000012345");
  assert.equal(JSON.stringify(result).includes("12345678"), false);
});

test("cancel verifies cancelable quantity before VTTC0013U mutation", async () => {
  const calls = [];
  const responses = [
    jsonResponse({ rt_cd: "0", output: [{ krx_fwdg_ord_orgno: "91234", odno: "0000012345", psbl_qty: "1", ord_qty: "1" }], ctx_area_fk100: "", ctx_area_nk100: "" }),
    jsonResponse({ rt_cd: "0", output: { KRX_FWDG_ORD_ORGNO: "91234", ODNO: "0000012346", ORD_TMD: "101600" } }),
  ];
  const client = new KisPaperTradingClient({
    config: config(),
    tokenStore: tokenStore({ accessToken: "paper-token", issuedAt: 1, expiresAt: Date.now() + 60_000 }),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return responses.shift();
    },
  });
  const result = await client.cancelOrder({
    originalOrderNumber: "0000012345",
    orderOrganizationNumber: "91234",
    quantity: 1,
    exchange: "KRX",
  });
  assert.equal(calls[0].options.headers.tr_id, "VTTC0084R");
  assert.equal(calls[1].options.headers.tr_id, "VTTC0013U");
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.RVSE_CNCL_DVSN_CD, "02");
  assert.equal(result.operation, "CANCEL");
});

test("network failure during mutation is marked ambiguous and secrets are redacted", async () => {
  const client = new KisPaperTradingClient({
    config: config(),
    tokenStore: tokenStore({ accessToken: "paper-token", issuedAt: 1, expiresAt: Date.now() + 60_000 }),
    fetchImpl: async () => { throw new Error("paper-key 12345678 socket reset"); },
  });
  await assert.rejects(() => client.submitOrder({
    side: "SELL",
    symbol: "005930",
    type: "MARKET",
    quantity: 1,
    exchange: "KRX",
  }), (error) => {
    assert.equal(error.ambiguous, true);
    assert.equal(error.message.includes("paper-key"), false);
    assert.equal(error.message.includes("12345678"), false);
    return true;
  });
});

test("paper sell uses latest VTTC0011U", async () => {
  const calls = [];
  const client = new KisPaperTradingClient({
    config: config(),
    tokenStore: tokenStore({ accessToken: "paper-token", issuedAt: 1, expiresAt: Date.now() + 60_000 }),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ rt_cd: "0", output: { KRX_FWDG_ORD_ORGNO: "91234", ODNO: "0000012347", ORD_TMD: "101700" } });
    },
  });
  await client.submitOrder({ side: "SELL", symbol: "005930", type: "MARKET", quantity: 1, exchange: "KRX" });
  const body = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].options.headers.tr_id, "VTTC0011U");
  assert.equal(body.SLL_TYPE, "01");
  assert.equal(body.ORD_DVSN, "01");
  assert.equal(body.ORD_UNPR, "0");
});

test("revise checks cancelable order then sends VTTC0013U division 01", async () => {
  const calls = [];
  const responses = [
    jsonResponse({ rt_cd: "0", output: [{ krx_fwdg_ord_orgno: "91234", odno: "0000012345", psbl_qty: "2", ord_qty: "2", ord_dvsn_cd: "00", ord_unpr: "70000" }], ctx_area_fk100: "", ctx_area_nk100: "" }),
    jsonResponse({ rt_cd: "0", output: { KRX_FWDG_ORD_ORGNO: "91234", ODNO: "0000012348", ORD_TMD: "101800" } }),
  ];
  const client = new KisPaperTradingClient({
    config: config(),
    tokenStore: tokenStore({ accessToken: "paper-token", issuedAt: 1, expiresAt: Date.now() + 60_000 }),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return responses.shift();
    },
  });
  await client.reviseOrder({
    originalOrderNumber: "0000012345",
    orderOrganizationNumber: "91234",
    type: "LIMIT",
    quantity: 1,
    limitPrice: 70500,
    exchange: "KRX",
  });
  const body = JSON.parse(calls[1].options.body);
  assert.equal(calls[0].options.headers.tr_id, "VTTC0084R");
  assert.equal(calls[1].options.headers.tr_id, "VTTC0013U");
  assert.equal(body.RVSE_CNCL_DVSN_CD, "01");
  assert.equal(body.ORD_DVSN, "00");
  assert.equal(body.ORD_UNPR, "70500");
});

test("cancel without type reuses original limit division and price", async () => {
  const calls = [];
  const responses = [
    jsonResponse({ rt_cd: "0", output: [{ krx_fwdg_ord_orgno: "91234", odno: "0000012345", psbl_qty: "1", ord_qty: "1", ord_dvsn_cd: "00", ord_unpr: "70000" }], ctx_area_fk100: "", ctx_area_nk100: "" }),
    jsonResponse({ rt_cd: "0", output: { KRX_FWDG_ORD_ORGNO: "91234", ODNO: "0000012349", ORD_TMD: "101900" } }),
  ];
  const client = new KisPaperTradingClient({
    config: config(),
    tokenStore: tokenStore({ accessToken: "paper-token", issuedAt: 1, expiresAt: Date.now() + 60_000 }),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return responses.shift();
    },
  });
  await client.cancelOrder({
    originalOrderNumber: "0000012345",
    orderOrganizationNumber: "91234",
    quantity: 1,
    exchange: "KRX",
  });
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.RVSE_CNCL_DVSN_CD, "02");
  assert.equal(body.ORD_DVSN, "00");
  assert.equal(body.ORD_UNPR, "70000");
});

test("redaction tolerates a damaged token store without masking network error", async () => {
  const brokenTokenStore = {
    loadValid() { throw new Error("damaged token cache"); },
    save(value) { return value; },
    status() { return { state: "BROKEN", expiresAt: null }; },
  };
  const client = new KisPaperTradingClient({
    config: config(),
    tokenStore: brokenTokenStore,
    fetchImpl: async () => { throw new Error("paper-key 12345678 socket reset"); },
  });
  await assert.rejects(
    () => client.rawRequest("테스트", new URL("https://openapivts.koreainvestment.com:29443/test"), { method: "GET", ambiguousOnFailure: false }),
    (error) => error.code === "KIS_PAPER_NETWORK_ERROR" && !error.message.includes("paper-key") && !error.message.includes("12345678"),
  );
});
