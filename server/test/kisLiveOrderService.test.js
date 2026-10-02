import assert from "node:assert/strict";
import test from "node:test";
import { KisLiveOrderService } from "../integrations/kis/kisLiveOrderService.js";
import { KisLiveApiError } from "../integrations/kis/kisLiveTradingClient.js";

class MemoryJournal {
  constructor(events = []) { this.events = structuredClone(events); }
  append(type, payload, timestamp) {
    const event = { sequence: this.events.length + 1, type, payload: structuredClone(payload), timestamp };
    this.events.push(event);
    return structuredClone(event);
  }
  readAll() { return structuredClone(this.events); }
}

function client(overrides = {}) {
  return {
    submitCalls: 0,
    async getBalance() { return { summary: { evaluationProfitLoss: 0 } }; },
    async submitOrder(request) { this.submitCalls += 1; return { status: "ACCEPTED", orderNumber: "1", request }; },
    async reviseOrder(request) { return { status: "ACCEPTED", orderNumber: "2", request }; },
    async cancelOrder(request) { return { status: "ACCEPTED", orderNumber: "3", request }; },
    ...overrides,
  };
}

function service(options = {}) {
  return new KisLiveOrderService({
    client: options.client ?? client(),
    journal: options.journal ?? new MemoryJournal(),
    limits: options.limits ?? { maxOrderQuantity: 1, maxOrderValue: 2_000_000, maxDailyOrders: 5, maxDailyLoss: 20_000, maxConsecutiveLosses: 2 },
    now: options.now ?? (() => Date.parse("2026-08-01T09:00:00Z")),
    commandIdFactory: options.commandIdFactory ?? (() => "command-1"),
    onUnknownResult: options.onUnknownResult ?? (() => {}),
  });
}

test("same clientOrderId is idempotent and does not call broker twice", async () => {
  const broker = client();
  const orders = service({ client: broker });
  const input = { clientOrderId: "order-1", side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 70000 };
  const first = await orders.submitOrder(input);
  const second = await orders.submitOrder(input);
  assert.equal(first.status, "ACCEPTED");
  assert.equal(second.replayed, true);
  assert.equal(broker.submitCalls, 1);
});

test("restart replays accepted result without reissuing order", async () => {
  const journal = new MemoryJournal();
  const firstBroker = client();
  const first = service({ client: firstBroker, journal });
  await first.submitOrder({ clientOrderId: "restart-1", side: "BUY", symbol: "005930", type: "MARKET", quantity: 1, referencePrice: 70000 });

  const secondBroker = client();
  const restarted = service({ client: secondBroker, journal });
  const replay = await restarted.submitOrder({ clientOrderId: "restart-1", side: "BUY", symbol: "005930", type: "MARKET", quantity: 1, referencePrice: 70000 });
  assert.equal(replay.status, "ACCEPTED");
  assert.equal(replay.replayed, true);
  assert.equal(secondBroker.submitCalls, 0);
});

test("interrupted command becomes UNKNOWN_RESULT on restart and activates kill switch", async () => {
  const timestamp = Date.parse("2026-08-01T09:00:00Z");
  const journal = new MemoryJournal([{ type: "BROKER_ORDER_COMMAND", timestamp, payload: { commandId: "c1", clientOrderId: "unknown-1", operation: "SUBMIT", request: { quantity: 1 }, timestamp, day: "2026-08-01" } }]);
  let callbackCount = 0;
  const orders = service({ journal, onUnknownResult: () => { callbackCount += 1; } });
  const status = orders.status();
  assert.equal(status.unknownResult, true);
  assert.equal(status.killSwitch, true);
  assert.equal(callbackCount, 1);
  const replay = await orders.submitOrder({ clientOrderId: "unknown-1", side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 70000 });
  assert.equal(replay.status, "UNKNOWN_RESULT");
  assert.equal(replay.replayed, true);
});

test("ambiguous broker failure is journaled and blocks later new orders", async () => {
  let callbackCount = 0;
  const broker = client({
    async submitOrder() {
      throw new KisLiveApiError("timeout", { code: "TIMEOUT", ambiguous: true, operation: "실전주문" });
    },
  });
  const orders = service({ client: broker, onUnknownResult: () => { callbackCount += 1; } });
  const first = await orders.submitOrder({ clientOrderId: "ambiguous-1", side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 70000 });
  assert.equal(first.status, "UNKNOWN_RESULT");
  assert.equal(callbackCount, 1);
  await assert.rejects(() => orders.submitOrder({ clientOrderId: "ambiguous-2", side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 70000 }), (error) => error.code === "KIS_LIVE_KILL_SWITCH");
});

test("journal command failure prevents any broker request", async () => {
  const broker = client();
  const journal = {
    readAll() { return []; },
    append() { throw new Error("disk full"); },
  };
  const orders = service({ client: broker, journal });
  await assert.rejects(() => orders.submitOrder({ clientOrderId: "journal-1", side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 70000 }), (error) => error.code === "KIS_LIVE_COMMAND_JOURNAL_FAILED");
  assert.equal(broker.submitCalls, 0);
});

test("daily loss limit turns on kill switch before broker mutation", async () => {
  const broker = client({
    async getBalance() { return { summary: { evaluationProfitLoss: -20_000 } }; },
  });
  const orders = service({ client: broker });
  await assert.rejects(() => orders.submitOrder({ clientOrderId: "loss-1", side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 70000 }), (error) => error.code === "KIS_LIVE_DAILY_LOSS_LIMIT");
  assert.equal(orders.status().killSwitch, true);
  assert.equal(broker.submitCalls, 0);
});

test("cancel remains available while kill switch is enabled", async () => {
  const broker = client();
  const orders = service({ client: broker });
  orders.setKillSwitch(true);
  const result = await orders.cancelOrder({ clientOrderId: "cancel-1", originalOrderNumber: "123", orderOrganizationNumber: "456", quantity: 1 });
  assert.equal(result.status, "ACCEPTED");
});

test("daily order count blocks the next mutation before broker call", async () => {
  const broker = client();
  const orders = service({
    client: broker,
    limits: { maxOrderQuantity: 1, maxOrderValue: 2_000_000, maxDailyOrders: 1, maxDailyLoss: 0, maxConsecutiveLosses: 0 },
    commandIdFactory: (() => { let id = 0; return () => `command-${++id}`; })(),
  });
  await orders.submitOrder({ clientOrderId: "count-1", side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 70000 });
  await assert.rejects(
    () => orders.submitOrder({ clientOrderId: "count-2", side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 70000 }),
    (error) => error.code === "KIS_LIVE_DAILY_ORDER_LIMIT",
  );
  assert.equal(broker.submitCalls, 1);
});

test("unknown result prevents kill switch from being manually cleared", () => {
  const timestamp = Date.parse("2026-08-01T09:00:00Z");
  const journal = new MemoryJournal([{ type: "BROKER_ORDER_COMMAND", timestamp, payload: { commandId: "c1", clientOrderId: "unknown-clear", operation: "SUBMIT", request: { quantity: 1 }, timestamp, day: "2026-08-01" } }]);
  const orders = service({ journal });
  assert.throws(
    () => orders.setKillSwitch(false),
    (error) => error.code === "KIS_LIVE_UNKNOWN_RESULT_UNRESOLVED",
  );
});

test("result journal failure transitions accepted broker order to UNKNOWN_RESULT", async () => {
  const broker = client();
  let appendCount = 0;
  const journal = {
    readAll() { return []; },
    append(type, payload, timestamp) {
      appendCount += 1;
      if (type === "BROKER_ORDER_RESULT") throw new Error("disk full after broker accepted");
      return { sequence: appendCount, type, payload, timestamp };
    },
  };
  const orders = service({ client: broker, journal });
  await assert.rejects(
    () => orders.submitOrder({ clientOrderId: "result-journal-1", side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 70000 }),
    (error) => error.code === "KIS_LIVE_RESULT_JOURNAL_FAILED" && error.ambiguous === true,
  );
  assert.equal(broker.submitCalls, 1);
  assert.equal(orders.status().unknownResult, true);
  assert.equal(orders.status().killSwitch, true);
  const replay = await orders.submitOrder({ clientOrderId: "result-journal-1", side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 70000 });
  assert.equal(replay.status, "UNKNOWN_RESULT");
  assert.equal(replay.replayed, true);
  assert.equal(broker.submitCalls, 1);
});

// 카나리 전용: 설정 상한(maxOrderQuantity)과 별개로 서비스 자체가 정확히 1주가 아니면 거부한다.
test("canary hard-rejects any quantity other than exactly 1 share, even under a looser config limit", async () => {
  const broker = client();
  const orders = service({
    client: broker,
    limits: { maxOrderQuantity: 10, maxOrderValue: 2_000_000, maxDailyOrders: 5, maxDailyLoss: 20_000, maxConsecutiveLosses: 2 },
  });
  await assert.rejects(
    () => orders.submitOrder({ clientOrderId: "canary-1", side: "BUY", symbol: "005930", type: "LIMIT", quantity: 2, limitPrice: 70000 }),
    (error) => error.code === "KIS_LIVE_CANARY_QUANTITY_LIMIT",
  );
  assert.equal(broker.submitCalls, 0);
});

test("consecutive loss streak turns on kill switch before broker mutation", async () => {
  const journal = new MemoryJournal();
  journal.append("BROKER_FILL_OBSERVED", { day: "2026-08-01", capturedAt: 1, orderedAt: 1, orderNumber: "1", orderOrganizationNumber: "1", symbol: "005930", side: "BUY", deltaQuantity: 1, executedPrice: 70_000, cumulativeExecutedQuantity: 1 }, 1);
  journal.append("BROKER_FILL_OBSERVED", { day: "2026-08-01", capturedAt: 2, orderedAt: 2, orderNumber: "2", orderOrganizationNumber: "1", symbol: "005930", side: "SELL", deltaQuantity: 1, executedPrice: 69_000, cumulativeExecutedQuantity: 1 }, 2);
  journal.append("BROKER_FILL_OBSERVED", { day: "2026-08-01", capturedAt: 3, orderedAt: 3, orderNumber: "3", orderOrganizationNumber: "1", symbol: "005930", side: "BUY", deltaQuantity: 1, executedPrice: 70_000, cumulativeExecutedQuantity: 1 }, 3);
  journal.append("BROKER_FILL_OBSERVED", { day: "2026-08-01", capturedAt: 4, orderedAt: 4, orderNumber: "4", orderOrganizationNumber: "1", symbol: "005930", side: "SELL", deltaQuantity: 1, executedPrice: 69_000, cumulativeExecutedQuantity: 1 }, 4);
  const broker = client({
    async getBalance() { return { summary: { evaluationProfitLoss: 0, totalEvaluationAmount: 1_000_000 }, positions: [] }; },
    async getDailyOrders() { return { orders: [] }; },
    async getCancelableOrders() { return []; },
  });
  const orders = service({ client: broker, journal });
  await assert.rejects(
    () => orders.submitOrder({ clientOrderId: "streak-1", side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 70000 }),
    (error) => error.code === "KIS_LIVE_CONSECUTIVE_LOSS_LIMIT",
  );
  assert.equal(orders.status().killSwitch, true);
  assert.equal(broker.submitCalls, 0);
});
