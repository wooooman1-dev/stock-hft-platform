import assert from "node:assert/strict";
import test from "node:test";
import { KisMainWorkspace } from "../domain/kisMainWorkspace.js";
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

function tokenStore() {
  return {
    loadValid() {
      return {
        accessToken: "paper-token",
        issuedAt: 1,
        expiresAt: Date.now() + 60_000,
      };
    },
    save(value) { return structuredClone(value); },
    status() { return { state: "VALID", expiresAt: Date.now() + 60_000 }; },
  };
}

function jsonResponse(payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

test("paper daily order inquiry uses VTTC0081R, pagination, and normalizes fill states", async () => {
  const calls = [];
  const responses = [
    jsonResponse({
      rt_cd: "0",
      output1: [{
        ord_dt: "20260804",
        ord_gno_brno: "00950",
        odno: "0000010300",
        orgn_odno: "",
        ord_dvsn_name: "시장가",
        sll_buy_dvsn_cd: "02",
        sll_buy_dvsn_cd_name: "현금매수",
        pdno: "005930",
        prdt_name: "삼성전자",
        ord_qty: "1",
        ord_unpr: "0",
        ord_tmd: "093107",
        tot_ccld_qty: "1",
        avg_prvs: "235000",
        cncl_yn: "N",
        tot_ccld_amt: "235000",
        ord_dvsn_cd: "01",
        cnc_cfrm_qty: "0",
        rmn_qty: "0",
        rjct_qty: "0",
        excg_id_dvsn_cd: "KRX",
      }],
      output2: {
        tot_ord_qty: "2",
        tot_ccld_qty: "1",
        tot_ccld_amt: "235000",
        prsm_tlex_smtl: "30",
        pchs_avg_pric: "235000",
      },
      ctx_area_fk100: "next-fk",
      ctx_area_nk100: "next-nk",
    }, { tr_cont: "M" }),
    jsonResponse({
      rt_cd: "0",
      output1: [{
        ord_dt: "20260804",
        ord_gno_brno: "00950",
        odno: "0000010400",
        ord_dvsn_name: "지정가",
        sll_buy_dvsn_cd: "01",
        sll_buy_dvsn_cd_name: "현금매도",
        pdno: "005930",
        prdt_name: "삼성전자",
        ord_qty: "2",
        ord_unpr: "236000",
        ord_tmd: "093200",
        tot_ccld_qty: "1",
        avg_prvs: "236000",
        cncl_yn: "N",
        tot_ccld_amt: "236000",
        ord_dvsn_cd: "00",
        cnc_cfrm_qty: "0",
        rmn_qty: "1",
        rjct_qty: "0",
        excg_id_dvsn_cd: "KRX",
      }],
      output2: {},
      ctx_area_fk100: "",
      ctx_area_nk100: "",
    }),
  ];
  const client = new KisPaperTradingClient({
    config: config(),
    tokenStore: tokenStore(),
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return responses.shift();
    },
    now: () => Date.parse("2026-08-04T01:30:00Z"),
  });

  const history = await client.getDailyOrders();

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, "/uapi/domestic-stock/v1/trading/inquire-daily-ccld");
  assert.equal(calls[0].options.headers.tr_id, "VTTC0081R");
  assert.equal(calls[0].url.searchParams.get("INQR_STRT_DT"), "20260804");
  assert.equal(calls[0].url.searchParams.get("SLL_BUY_DVSN_CD"), "00");
  assert.equal(calls[0].url.searchParams.get("CCLD_DVSN"), "00");
  assert.equal(calls[0].url.searchParams.get("EXCG_ID_DVSN_CD"), "ALL");
  assert.equal(calls[1].options.headers.tr_cont, "N");
  assert.equal(calls[1].url.searchParams.get("CTX_AREA_FK100"), "next-fk");
  assert.equal(history.orders.length, 2);
  assert.equal(history.orders[0].orderNumber, "0000010400");
  assert.equal(history.orders[0].status, "PARTIALLY_FILLED");
  assert.equal(history.orders[0].remainingQuantity, 1);
  assert.equal(history.orders[1].status, "FILLED");
  assert.equal(history.orders[1].averageExecutedPrice, 235000);
  assert.equal(history.summary.estimatedFeesAndTaxes, 30);
});

test("main workspace exposes broker order history and throttles ordinary refreshes", async () => {
  let clock = Date.parse("2026-08-04T01:30:00Z");
  let historyCalls = 0;
  const history = {
    fetchedAt: clock,
    orders: [{
      orderDate: "20260804",
      orderTime: "103000",
      orderedAt: clock,
      orderOrganizationNumber: "00950",
      orderNumber: "0000010300",
      symbol: "005930",
      name: "삼성전자",
      side: "BUY",
      type: "MARKET",
      orderQuantity: 1,
      orderPrice: 0,
      executedQuantity: 1,
      averageExecutedPrice: 235000,
      remainingQuantity: 0,
      canceledQuantity: 0,
      rejectedQuantity: 0,
      status: "FILLED",
    }],
    summary: { totalOrderQuantity: 1, totalExecutedQuantity: 1 },
  };
  const paperService = {
    commands: new Map(),
    status() { return { killSwitch: false, unknownResult: false }; },
    async getBalance() {
      return {
        fetchedAt: clock,
        positions: [],
        summary: { cash: 10_000_000, totalEvaluationAmount: 10_000_000 },
      };
    },
  };
  const paperClient = {
    async getCancelableOrders() { return []; },
    async getDailyOrders() {
      historyCalls += 1;
      return { ...structuredClone(history), fetchedAt: clock };
    },
  };
  const workspace = new KisMainWorkspace({
    selection: {
      symbol: "005930",
      symbolName: "삼성전자",
      initialPrice: 235000,
      previousClose: 234000,
      tickSize: 500,
    },
    paperService,
    paperClient,
    now: () => clock,
    orderHistoryRefreshMs: 15_000,
  });

  await workspace.refreshAccount();
  let snapshot = workspace.snapshot();
  assert.equal(historyCalls, 1);
  assert.equal(snapshot.account.orders.length, 1);
  assert.equal(snapshot.account.orders[0].status, "FILLED");
  assert.equal(snapshot.account.orderHistoryFetchedAt, clock);
  assert.equal(snapshot.account.orderHistoryError, null);

  clock += 5_000;
  await workspace.refreshAccount();
  assert.equal(historyCalls, 1);

  await workspace.refreshAccount({ forceOrderHistory: true });
  snapshot = workspace.snapshot();
  assert.equal(historyCalls, 2);
  assert.equal(snapshot.account.orders[0].orderNumber, "0000010300");
});

test("order history failure does not hide KIS balance or journal commands", async () => {
  const clock = Date.parse("2026-08-04T01:30:00Z");
  const paperService = {
    commands: new Map([["journal-1", {
      clientOrderId: "journal-1",
      operation: "SUBMIT",
      request: { side: "BUY", symbol: "005930", quantity: 1, type: "MARKET" },
      timestamp: clock,
      state: "RESULT",
      result: { status: "ACCEPTED", result: { orderNumber: "0000010300" } },
    }]]),
    status() { return { killSwitch: false, unknownResult: false }; },
    async getBalance() {
      return {
        fetchedAt: clock,
        positions: [],
        summary: { cash: 10_000_000, totalEvaluationAmount: 10_000_000 },
      };
    },
  };
  const workspace = new KisMainWorkspace({
    selection: {
      symbol: "005930",
      symbolName: "삼성전자",
      initialPrice: 235000,
      previousClose: 234000,
      tickSize: 500,
    },
    paperService,
    paperClient: {
      async getCancelableOrders() { return []; },
      async getDailyOrders() {
        const error = new Error("order history unavailable");
        error.code = "KIS_PAPER_ORDER_HISTORY_REJECTED";
        throw error;
      },
    },
    now: () => clock,
  });

  await workspace.refreshAccount();
  const snapshot = workspace.snapshot();
  assert.equal(snapshot.account.available, true);
  assert.equal(snapshot.account.equity, 10_000_000);
  assert.equal(snapshot.account.orders.length, 0);
  assert.equal(snapshot.account.commands.length, 1);
  assert.equal(snapshot.account.orderHistoryError.code, "KIS_PAPER_ORDER_HISTORY_REJECTED");
});
