import assert from "node:assert/strict";
import test from "node:test";
import { KisPaperTradingClient } from "../integrations/kis/kisPaperTradingClient.js";
import { KisPaperOrderService } from "../integrations/kis/kisPaperOrderService.js";

// 이 파일은 실제 HTTP 계층(KisPaperTradingClient의 fetch/재시도/JSON 파싱)에서 발생하는
// 네트워크 타임아웃, 5xx, 잘못된 JSON, 명확한 거절 응답을 주입해 KisPaperOrderService의
// UNKNOWN_RESULT 처리·킬 스위치·재시작 멱등 복원이 실제로 각 실패 유형에서 올바르게
// 동작하는지 종단 간(end-to-end)으로 검증한다.

const BALANCE_PATH = "/uapi/domestic-stock/v1/trading/inquire-balance";
const ORDER_CASH_PATH = "/uapi/domestic-stock/v1/trading/order-cash";
const ORDER_REVISE_CANCEL_PATH = "/uapi/domestic-stock/v1/trading/order-rvsecncl";
const DAILY_ORDERS_PATH = "/uapi/domestic-stock/v1/trading/inquire-daily-ccld";
const NOW = Date.parse("2026-08-04T01:15:00Z");

class MemoryJournal {
  constructor(events = []) { this.events = structuredClone(events); }
  append(type, payload, timestamp) {
    const event = { sequence: this.events.length + 1, type, payload: structuredClone(payload), timestamp };
    this.events.push(event);
    return structuredClone(event);
  }
  readAll() { return structuredClone(this.events); }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function malformedJsonResponse(status = 200) {
  return new Response("<html>not json</html>", { status, headers: { "Content-Type": "text/plain" } });
}

function emptyBalanceResponse() {
  return jsonResponse({ rt_cd: "0", output1: [], output2: [{}] });
}

function dailyOrdersResponse(orders = []) {
  return jsonResponse({ rt_cd: "0", output1: orders, ctx_area_fk100: "", ctx_area_nk100: "" });
}

function rawOrder({
  orderNumber = "0000010500",
  organizationNumber = "00950",
  quantity = 1,
  executedQuantity = 0,
} = {}) {
  return {
    ord_dt: "20260804",
    ord_tmd: "090500",
    ord_gno_brno: organizationNumber,
    odno: orderNumber,
    orgn_odno: "",
    pdno: "005930",
    prdt_name: "삼성전자",
    sll_buy_dvsn_cd: "02",
    ord_dvsn_cd: "00",
    ord_dvsn_name: "지정가",
    ord_qty: String(quantity),
    ord_unpr: "70000",
    tot_ccld_qty: String(executedQuantity),
    avg_prvs: "0",
    tot_ccld_amt: "0",
    cnc_cfrm_qty: "0",
    rmn_qty: String(quantity - executedQuantity),
    rjct_qty: "0",
    cncl_yn: "N",
  };
}

function hangingUntilAbort() {
  return (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    });
  });
}

function faultInjectionClient({
  mutation,
  balance = emptyBalanceResponse,
  dailyOrders = () => dailyOrdersResponse([]),
  timeoutMs = 50,
} = {}) {
  const fetchImpl = async (url, requestOptions) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === BALANCE_PATH) return balance();
    if (pathname === DAILY_ORDERS_PATH) return dailyOrders();
    if (pathname === ORDER_CASH_PATH || pathname === ORDER_REVISE_CANCEL_PATH) return mutation(url, requestOptions);
    throw new Error(`fault injection test: unexpected request path ${pathname}`);
  };
  return new KisPaperTradingClient({
    config: {
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
    },
    tokenStore: {
      loadValid() { return { accessToken: "paper-token", issuedAt: 1, expiresAt: NOW + 60_000 }; },
      save(value) { return structuredClone(value); },
      status() { return { state: "VALID", expiresAt: NOW + 60_000 }; },
    },
    fetchImpl,
    now: () => NOW,
    requestSpacingMs: 0,
    readRetryDelayMs: 0,
    dailyOrdersCacheMs: 1_000,
    timeoutMs,
  });
}

function service({ client, journal = new MemoryJournal(), onUnknownResult = () => {} } = {}) {
  return new KisPaperOrderService({
    client,
    journal,
    limits: { maxOrderQuantity: 10, maxOrderValue: 10_000_000, maxDailyOrders: 20, maxDailyLoss: 0 },
    now: () => NOW,
    commandIdFactory: (() => { let sequence = 0; return () => `command-${++sequence}`; })(),
    onUnknownResult,
  });
}

function submitInput(overrides = {}) {
  return {
    clientOrderId: "fault-1",
    side: "BUY",
    symbol: "005930",
    type: "LIMIT",
    quantity: 1,
    limitPrice: 70_000,
    ...overrides,
  };
}

test("a timeout during submit produces UNKNOWN_RESULT, trips the kill switch, and survives a restart", async () => {
  const journal = new MemoryJournal();
  const client = faultInjectionClient({ mutation: hangingUntilAbort() });
  let callbackCount = 0;
  const orders = service({ client, journal, onUnknownResult: () => { callbackCount += 1; } });

  const result = await orders.submitOrder(submitInput({ clientOrderId: "timeout-1" }));
  assert.equal(result.status, "UNKNOWN_RESULT");
  assert.equal(callbackCount, 1);
  assert.equal(orders.status().unknownResult, true);
  assert.equal(orders.status().killSwitch, true);

  await assert.rejects(
    () => orders.submitOrder(submitInput({ clientOrderId: "timeout-2" })),
    (error) => error.statusCode === 423
      && (error.code === "KIS_PAPER_KILL_SWITCH" || error.code === "KIS_PAPER_RECONCILIATION_BLOCKED"),
  );

  const restarted = service({ client: faultInjectionClient({ mutation: hangingUntilAbort() }), journal });
  assert.equal(restarted.status().unknownResult, true);
  assert.equal(restarted.status().killSwitch, true);
  const replay = await restarted.submitOrder(submitInput({ clientOrderId: "timeout-1" }));
  assert.equal(replay.status, "UNKNOWN_RESULT");
  assert.equal(replay.replayed, true);
});

test("an HTTP 5xx response during submit is treated as ambiguous and trips the kill switch", async () => {
  const client = faultInjectionClient({
    mutation: async () => jsonResponse({ rt_cd: "1", msg1: "internal server error" }, 503),
  });
  const orders = service({ client });
  const result = await orders.submitOrder(submitInput({ clientOrderId: "http5xx-1" }));
  assert.equal(result.status, "UNKNOWN_RESULT");
  assert.equal(orders.status().killSwitch, true);
});

test("a malformed JSON response during submit is treated as ambiguous and trips the kill switch", async () => {
  const client = faultInjectionClient({
    mutation: async () => malformedJsonResponse(200),
  });
  const orders = service({ client });
  const result = await orders.submitOrder(submitInput({ clientOrderId: "malformed-1" }));
  assert.equal(result.status, "UNKNOWN_RESULT");
  assert.equal(orders.status().killSwitch, true);
});

test("an HTTP 4xx response during submit is a clean rejection that never trips the kill switch", async () => {
  let calls = 0;
  const client = faultInjectionClient({
    mutation: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ rt_cd: "1", msg1: "invalid request" }, 400);
      return jsonResponse({
        rt_cd: "0",
        msg1: "정상처리",
        output: { ODNO: "0000010600", KRX_FWDG_ORD_ORGNO: "00950", ORD_TMD: "090501" },
      });
    },
  });
  const orders = service({ client });
  const rejected = await orders.submitOrder(submitInput({ clientOrderId: "http4xx-1" }));
  assert.equal(rejected.status, "REJECTED");
  assert.equal(orders.status().killSwitch, false);
  assert.equal(orders.status().unknownResult, false);

  const accepted = await orders.submitOrder(submitInput({ clientOrderId: "http4xx-2" }));
  assert.equal(accepted.status, "ACCEPTED");
});

test("a business-level rejection (HTTP 200, rt_cd != 0) never trips the kill switch", async () => {
  const client = faultInjectionClient({
    mutation: async () => jsonResponse({ rt_cd: "1", msg1: "주문가능금액 부족" }, 200),
  });
  const orders = service({ client });
  const rejected = await orders.submitOrder(submitInput({ clientOrderId: "business-reject-1" }));
  assert.equal(rejected.status, "REJECTED");
  assert.equal(orders.status().killSwitch, false);
});

test("a timeout during cancel produces UNKNOWN_RESULT and trips the kill switch", async () => {
  const client = faultInjectionClient({
    mutation: hangingUntilAbort(),
    dailyOrders: () => dailyOrdersResponse([rawOrder({ orderNumber: "0000010500", quantity: 2, executedQuantity: 0 })]),
  });
  const orders = service({ client });
  const result = await orders.cancelOrder({
    clientOrderId: "cancel-fault-1",
    originalOrderNumber: "0000010500",
    orderOrganizationNumber: "00950",
    quantity: 2,
  });
  assert.equal(result.status, "UNKNOWN_RESULT");
  assert.equal(orders.status().killSwitch, true);
});
