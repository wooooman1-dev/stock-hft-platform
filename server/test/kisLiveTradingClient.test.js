import assert from "node:assert/strict";
import test from "node:test";
import { KisLiveTradingClient } from "../integrations/kis/kisLiveTradingClient.js";

function config(overrides = {}) {
  return {
    enabled: true,
    configured: true,
    mode: "LIVE_TRADING",
    environment: "LIVE",
    baseUrl: "https://openapi.koreainvestment.com:9443",
    appKey: "live-key",
    appSecret: "live-secret",
    accountNumber: "12345678",
    accountProductCode: "01",
    orderEnabled: true,
    limits: {},
    ...overrides,
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

function dailyOrder({
  orderNumber = "0000012345",
  organizationNumber = "91234",
  quantity = 1,
  executedQuantity = 0,
  remainingQuantity = quantity - executedQuantity,
  orderDivision = "00",
  orderPrice = 70000,
  side = "02",
} = {}) {
  return {
    ord_dt: "20260804",
    ord_tmd: "101500",
    ord_gno_brno: organizationNumber,
    odno: orderNumber,
    orgn_odno: "",
    pdno: "005930",
    prdt_name: "삼성전자",
    sll_buy_dvsn_cd: side,
    ord_dvsn_cd: orderDivision,
    ord_dvsn_name: orderDivision === "00" ? "지정가" : "시장가",
    ord_qty: String(quantity),
    ord_unpr: String(orderPrice),
    tot_ccld_qty: String(executedQuantity),
    avg_prvs: executedQuantity > 0 ? String(orderPrice) : "0",
    tot_ccld_amt: String(executedQuantity * orderPrice),
    cnc_cfrm_qty: "0",
    rmn_qty: String(remainingQuantity),
    rjct_qty: "0",
    cncl_yn: "N",
  };
}

function dailyHistoryResponse(orders) {
  return jsonResponse({
    rt_cd: "0",
    output1: orders,
    output2: {},
    ctx_area_fk100: "",
    ctx_area_nk100: "",
  });
}

function liveClient(fetchImpl, options = {}) {
  return new KisLiveTradingClient({
    config: config(options.config ?? {}),
    tokenStore: tokenStore({ accessToken: "live-token", issuedAt: 1, expiresAt: Date.now() + 60_000 }),
    fetchImpl,
    now: options.now ?? (() => Date.parse("2026-08-04T01:15:00Z")),
    requestSpacingMs: options.requestSpacingMs ?? 0,
    readRetryDelayMs: options.readRetryDelayMs ?? 0,
    dailyOrdersCacheMs: options.dailyOrdersCacheMs ?? 1_000,
  });
}

test("live balance uses the production host, live credentials, and TTTC8434R", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return jsonResponse({
      rt_cd: "0",
      output1: [{ pdno: "005930", prdt_name: "삼성전자", hldg_qty: "1", ord_psbl_qty: "1", pchs_avg_pric: "70000", prpr: "71000", evlu_amt: "71000", evlu_pfls_amt: "1000", evlu_pfls_rt: "1.42" }],
      output2: [{ dnca_tot_amt: "900000", evlu_pfls_smtl_amt: "1000", tot_evlu_amt: "971000" }],
      ctx_area_fk100: "",
      ctx_area_nk100: "",
    });
  };
  const client = liveClient(fetchImpl);
  const balance = await client.getBalance();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/openapi\.koreainvestment\.com:9443\/uapi\/domestic-stock\/v1\/trading\/inquire-balance/);
  assert.equal(calls[0].options.headers.tr_id, "TTTC8434R");
  assert.equal(calls[0].options.headers.appkey, "live-key");
  assert.equal(balance.positions[0].quantity, 1);
  assert.equal(balance.summary.evaluationProfitLoss, 1000);
});

test("live buy uses TTTC0012U and required exchange field", async () => {
  const calls = [];
  const client = liveClient(async (url, options) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ rt_cd: "0", output: { KRX_FWDG_ORD_ORGNO: "91234", ODNO: "0000012345", ORD_TMD: "101500" } });
  }, { now: () => 1234 });
  const result = await client.submitOrder({
    side: "BUY",
    symbol: "005930",
    type: "LIMIT",
    quantity: 1,
    limitPrice: 70000,
    exchange: "KRX",
  });
  const body = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].options.headers.tr_id, "TTTC0012U");
  assert.equal(body.EXCG_ID_DVSN_CD, "KRX");
  assert.equal(body.ORD_DVSN, "00");
  assert.equal(body.ORD_UNPR, "70000");
  assert.equal(result.orderNumber, "0000012345");
  assert.equal(JSON.stringify(result).includes("12345678"), false);
});

test("live sell uses TTTC0011U", async () => {
  const calls = [];
  const client = liveClient(async (url, options) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ rt_cd: "0", output: { KRX_FWDG_ORD_ORGNO: "91234", ODNO: "0000012347", ORD_TMD: "101700" } });
  });
  await client.submitOrder({ side: "SELL", symbol: "005930", type: "MARKET", quantity: 1, exchange: "KRX" });
  const body = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].options.headers.tr_id, "TTTC0011U");
  assert.equal(body.SLL_TYPE, "01");
  assert.equal(body.ORD_DVSN, "01");
  assert.equal(body.ORD_UNPR, "0");
});

test("submitOrder and reviseOrder refuse to call KIS when the second order-enabled gate is off", async () => {
  const client = liveClient(async () => jsonResponse({ rt_cd: "0", output: {} }), { config: { orderEnabled: false } });
  await assert.rejects(
    () => client.submitOrder({ side: "BUY", symbol: "005930", type: "MARKET", quantity: 1, exchange: "KRX" }),
    (error) => error.code === "KIS_LIVE_ORDER_SUBMISSION_DISABLED",
  );
  await assert.rejects(
    () => client.reviseOrder({ originalOrderNumber: "1", orderOrganizationNumber: "1", quantity: 1, limitPrice: 70000 }),
    (error) => error.code === "KIS_LIVE_ORDER_SUBMISSION_DISABLED",
  );
});

test("live cancelable orders use TTTC0081R daily history and filter filled orders", async () => {
  const calls = [];
  const client = liveClient(async (url, options) => {
    calls.push({ url: String(url), options });
    return dailyHistoryResponse([
      dailyOrder({ orderNumber: "0000012345", quantity: 2, executedQuantity: 1, remainingQuantity: 1 }),
      dailyOrder({ orderNumber: "0000012346", quantity: 1, executedQuantity: 1, remainingQuantity: 0 }),
    ]);
  });
  const orders = await client.getCancelableOrders();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /inquire-daily-ccld/);
  assert.equal(calls[0].options.headers.tr_id, "TTTC0081R");
  assert.equal(orders.length, 1);
  assert.equal(orders[0].orderNumber, "0000012345");
  assert.equal(orders[0].cancelableQuantity, 1);
});

test("cancel verifies daily-history remaining quantity before TTTC0013U mutation (cancel allowed even when order-disabled)", async () => {
  const calls = [];
  const responses = [
    dailyHistoryResponse([dailyOrder({ remainingQuantity: 1 })]),
    jsonResponse({ rt_cd: "0", output: { KRX_FWDG_ORD_ORGNO: "91234", ODNO: "0000012346", ORD_TMD: "101600" } }),
  ];
  const client = liveClient(async (url, options) => {
    calls.push({ url: String(url), options });
    return responses.shift();
  }, { config: { orderEnabled: false } });
  const result = await client.cancelOrder({
    originalOrderNumber: "0000012345",
    orderOrganizationNumber: "91234",
    quantity: 1,
    exchange: "KRX",
  });
  assert.equal(calls[0].options.headers.tr_id, "TTTC0081R");
  assert.equal(calls[1].options.headers.tr_id, "TTTC0013U");
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.RVSE_CNCL_DVSN_CD, "02");
  assert.equal(result.operation, "CANCEL");
});

test("revise checks daily-history remaining order then sends TTTC0013U division 01", async () => {
  const calls = [];
  const responses = [
    dailyHistoryResponse([dailyOrder({ quantity: 2, remainingQuantity: 2, orderDivision: "00", orderPrice: 70000 })]),
    jsonResponse({ rt_cd: "0", output: { KRX_FWDG_ORD_ORGNO: "91234", ODNO: "0000012348", ORD_TMD: "101800" } }),
  ];
  const client = liveClient(async (url, options) => {
    calls.push({ url: String(url), options });
    return responses.shift();
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
  assert.equal(calls[0].options.headers.tr_id, "TTTC0081R");
  assert.equal(calls[1].options.headers.tr_id, "TTTC0013U");
  assert.equal(body.RVSE_CNCL_DVSN_CD, "01");
  assert.equal(body.ORD_UNPR, "70500");
});

test("live GET retries EGW00201 once without retrying a mutation", async () => {
  let readCalls = 0;
  const readClient = liveClient(async () => {
    readCalls += 1;
    if (readCalls === 1) {
      return jsonResponse({ rt_cd: "1", msg_cd: "EGW00201", msg1: "초당 거래건수 를 초과하였습니다." });
    }
    return dailyHistoryResponse([]);
  }, { dailyOrdersCacheMs: 0 });
  const history = await readClient.getDailyOrders();
  assert.equal(readCalls, 2);
  assert.equal(history.orders.length, 0);

  let mutationCalls = 0;
  const mutationClient = liveClient(async () => {
    mutationCalls += 1;
    return jsonResponse({ rt_cd: "1", msg_cd: "EGW00201", msg1: "초당 거래건수 를 초과하였습니다." });
  });
  await assert.rejects(() => mutationClient.submitOrder({
    side: "BUY",
    symbol: "005930",
    type: "MARKET",
    quantity: 1,
    exchange: "KRX",
  }));
  assert.equal(mutationCalls, 1);
});

test("network failure during mutation is marked ambiguous and secrets are redacted", async () => {
  const client = liveClient(async () => { throw new Error("live-key 12345678 socket reset"); });
  await assert.rejects(() => client.submitOrder({
    side: "SELL",
    symbol: "005930",
    type: "MARKET",
    quantity: 1,
    exchange: "KRX",
  }), (error) => {
    assert.equal(error.ambiguous, true);
    assert.equal(error.message.includes("live-key"), false);
    assert.equal(error.message.includes("12345678"), false);
    return true;
  });
});

test("redaction tolerates a damaged token store without masking network error", async () => {
  const brokenTokenStore = {
    loadValid() { throw new Error("damaged token cache"); },
    save(value) { return value; },
    status() { return { state: "BROKEN", expiresAt: null }; },
  };
  const client = new KisLiveTradingClient({
    config: config(),
    tokenStore: brokenTokenStore,
    fetchImpl: async () => { throw new Error("live-key 12345678 socket reset"); },
    requestSpacingMs: 0,
    readRetryDelayMs: 0,
  });
  await assert.rejects(
    () => client.rawRequest("테스트", new URL("https://openapi.koreainvestment.com:9443/test"), { method: "GET", ambiguousOnFailure: false }),
    (error) => error.code === "KIS_LIVE_NETWORK_ERROR" && !error.message.includes("live-key") && !error.message.includes("12345678"),
  );
});
