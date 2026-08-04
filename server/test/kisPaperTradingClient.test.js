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

function paperClient(fetchImpl, options = {}) {
  return new KisPaperTradingClient({
    config: config(),
    tokenStore: tokenStore({ accessToken: "paper-token", issuedAt: 1, expiresAt: Date.now() + 60_000 }),
    fetchImpl,
    now: options.now ?? (() => Date.parse("2026-08-04T01:15:00Z")),
    requestSpacingMs: options.requestSpacingMs ?? 0,
    readRetryDelayMs: options.readRetryDelayMs ?? 0,
    dailyOrdersCacheMs: options.dailyOrdersCacheMs ?? 1_000,
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
  const client = paperClient(fetchImpl);
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
  const client = paperClient(async (url, options) => {
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
  assert.equal(calls[0].options.headers.tr_id, "VTTC0012U");
  assert.equal(body.EXCG_ID_DVSN_CD, "KRX");
  assert.equal(body.ORD_DVSN, "00");
  assert.equal(body.ORD_UNPR, "70000");
  assert.equal(result.orderNumber, "0000012345");
  assert.equal(JSON.stringify(result).includes("12345678"), false);
});

test("paper cancelable orders use supported VTTC0081R daily history and filter filled orders", async () => {
  const calls = [];
  const client = paperClient(async (url, options) => {
    calls.push({ url: String(url), options });
    return dailyHistoryResponse([
      dailyOrder({ orderNumber: "0000012345", quantity: 2, executedQuantity: 1, remainingQuantity: 1 }),
      dailyOrder({ orderNumber: "0000012346", quantity: 1, executedQuantity: 1, remainingQuantity: 0 }),
    ]);
  });
  const orders = await client.getCancelableOrders();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /inquire-daily-ccld/);
  assert.equal(calls[0].options.headers.tr_id, "VTTC0081R");
  assert.equal(calls[0].url.includes("inquire-psbl-rvsecncl"), false);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].orderNumber, "0000012345");
  assert.equal(orders[0].cancelableQuantity, 1);
  assert.equal(orders[0].executedQuantity, 1);
});

test("concurrent order history consumers share one VTTC0081R request", async () => {
  const calls = [];
  const client = paperClient(async (url, options) => {
    calls.push({ url: String(url), options });
    await Promise.resolve();
    return dailyHistoryResponse([
      dailyOrder({ quantity: 2, executedQuantity: 1, remainingQuantity: 1 }),
    ]);
  });
  const [history, cancelable] = await Promise.all([
    client.getDailyOrders(),
    client.getCancelableOrders(),
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.tr_id, "VTTC0081R");
  assert.equal(history.orders.length, 1);
  assert.equal(cancelable.length, 1);
  assert.equal(cancelable[0].cancelableQuantity, 1);
});

test("paper GET retries EGW00201 once without retrying a mutation", async () => {
  let readCalls = 0;
  const readClient = paperClient(async () => {
    readCalls += 1;
    if (readCalls === 1) {
      return jsonResponse({
        rt_cd: "1",
        msg_cd: "EGW00201",
        msg1: "초당 거래건수 를 초과하였습니다.",
      });
    }
    return dailyHistoryResponse([]);
  }, { dailyOrdersCacheMs: 0 });
  const history = await readClient.getDailyOrders();
  assert.equal(readCalls, 2);
  assert.equal(history.orders.length, 0);

  let mutationCalls = 0;
  const mutationClient = paperClient(async () => {
    mutationCalls += 1;
    return jsonResponse({
      rt_cd: "1",
      msg_cd: "EGW00201",
      msg1: "초당 거래건수 를 초과하였습니다.",
    });
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

test("cancel verifies daily-history remaining quantity before VTTC0013U mutation", async () => {
  const calls = [];
  const responses = [
    dailyHistoryResponse([dailyOrder({ remainingQuantity: 1 })]),
    jsonResponse({ rt_cd: "0", output: { KRX_FWDG_ORD_ORGNO: "91234", ODNO: "0000012346", ORD_TMD: "101600" } }),
  ];
  const client = paperClient(async (url, options) => {
    calls.push({ url: String(url), options });
    return responses.shift();
  });
  const result = await client.cancelOrder({
    originalOrderNumber: "0000012345",
    orderOrganizationNumber: "91234",
    quantity: 1,
    exchange: "KRX",
  });
  assert.equal(calls[0].options.headers.tr_id, "VTTC0081R");
  assert.equal(calls[1].options.headers.tr_id, "VTTC0013U");
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.RVSE_CNCL_DVSN_CD, "02");
  assert.equal(result.operation, "CANCEL");
});

test("network failure during mutation is marked ambiguous and secrets are redacted", async () => {
  const client = paperClient(async () => { throw new Error("paper-key 12345678 socket reset"); });
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
  const client = paperClient(async (url, options) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ rt_cd: "0", output: { KRX_FWDG_ORD_ORGNO: "91234", ODNO: "0000012347", ORD_TMD: "101700" } });
  });
  await client.submitOrder({ side: "SELL", symbol: "005930", type: "MARKET", quantity: 1, exchange: "KRX" });
  const body = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].options.headers.tr_id, "VTTC0011U");
  assert.equal(body.SLL_TYPE, "01");
  assert.equal(body.ORD_DVSN, "01");
  assert.equal(body.ORD_UNPR, "0");
});

test("revise checks daily-history remaining order then sends VTTC0013U division 01", async () => {
  const calls = [];
  const responses = [
    dailyHistoryResponse([dailyOrder({ quantity: 2, remainingQuantity: 2, orderDivision: "00", orderPrice: 70000 })]),
    jsonResponse({ rt_cd: "0", output: { KRX_FWDG_ORD_ORGNO: "91234", ODNO: "0000012348", ORD_TMD: "101800" } }),
  ];
  const client = paperClient(async (url, options) => {
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
  assert.equal(calls[0].options.headers.tr_id, "VTTC0081R");
  assert.equal(calls[1].options.headers.tr_id, "VTTC0013U");
  assert.equal(body.RVSE_CNCL_DVSN_CD, "01");
  assert.equal(body.ORD_DVSN, "00");
  assert.equal(body.ORD_UNPR, "70500");
});

test("cancel without type reuses original limit division and price from daily history", async () => {
  const calls = [];
  const responses = [
    dailyHistoryResponse([dailyOrder({ remainingQuantity: 1, orderDivision: "00", orderPrice: 70000 })]),
    jsonResponse({ rt_cd: "0", output: { KRX_FWDG_ORD_ORGNO: "91234", ODNO: "0000012349", ORD_TMD: "101900" } }),
  ];
  const client = paperClient(async (url, options) => {
    calls.push({ url: String(url), options });
    return responses.shift();
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
    requestSpacingMs: 0,
    readRetryDelayMs: 0,
  });
  await assert.rejects(
    () => client.rawRequest("테스트", new URL("https://openapivts.koreainvestment.com:29443/test"), { method: "GET", ambiguousOnFailure: false }),
    (error) => error.code === "KIS_PAPER_NETWORK_ERROR" && !error.message.includes("paper-key") && !error.message.includes("12345678"),
  );
});
