import assert from "node:assert/strict";
import test from "node:test";
import { KisPaperOrderService } from "../integrations/kis/kisPaperOrderService.js";
import { KisPaperApiError } from "../integrations/kis/kisPaperTradingClient.js";

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
  return new KisPaperOrderService({
    client: options.client ?? client(),
    journal: options.journal ?? new MemoryJournal(),
    limits: options.limits ?? { maxOrderQuantity: 10, maxOrderValue: 1_000_000, maxDailyOrders: 20, maxDailyLoss: 100_000 },
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
      throw new KisPaperApiError("timeout", { code: "TIMEOUT", ambiguous: true, operation: "모의주문" });
    },
  });
  const orders = service({ client: broker, onUnknownResult: () => { callbackCount += 1; } });
  const first = await orders.submitOrder({ clientOrderId: "ambiguous-1", side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 70000 });
  assert.equal(first.status, "UNKNOWN_RESULT");
  assert.equal(callbackCount, 1);
  await assert.rejects(() => orders.submitOrder({ clientOrderId: "ambiguous-2", side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 70000 }), (error) => error.code === "KIS_PAPER_KILL_SWITCH");
});

test("journal command failure prevents any broker request", async () => {
  const broker = client();
  const journal = {
    readAll() { return []; },
    append() { throw new Error("disk full"); },
  };
  const orders = service({ client: broker, journal });
  await assert.rejects(() => orders.submitOrder({ clientOrderId: "journal-1", side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 70000 }), (error) => error.code === "KIS_PAPER_COMMAND_JOURNAL_FAILED");
  assert.equal(broker.submitCalls, 0);
});

test("daily loss limit turns on kill switch before broker mutation", async () => {
  const broker = client({
    async getBalance() { return { summary: { evaluationProfitLoss: -100_000 } }; },
  });
  const orders = service({ client: broker });
  await assert.rejects(() => orders.submitOrder({ clientOrderId: "loss-1", side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 70000 }), (error) => error.code === "KIS_PAPER_DAILY_LOSS_LIMIT");
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
    limits: { maxOrderQuantity: 10, maxOrderValue: 1_000_000, maxDailyOrders: 1, maxDailyLoss: 0 },
    commandIdFactory: (() => { let id = 0; return () => `command-${++id}`; })(),
  });
  await orders.submitOrder({ clientOrderId: "count-1", side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 70000 });
  await assert.rejects(
    () => orders.submitOrder({ clientOrderId: "count-2", side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 70000 }),
    (error) => error.code === "KIS_PAPER_DAILY_ORDER_LIMIT",
  );
  assert.equal(broker.submitCalls, 1);
});

test("daily loss baseline is persisted and reused after restart", async () => {
  const journal = new MemoryJournal();
  let totalEvaluationAmount = 1_000_000;
  const balanceClient = client({
    async getBalance() {
      return { summary: { totalEvaluationAmount, evaluationProfitLoss: 0 } };
    },
  });
  const first = service({ client: balanceClient, journal, commandIdFactory: () => "baseline-command-1" });
  await first.submitOrder({ clientOrderId: "baseline-1", side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 70000 });
  assert.equal(journal.events.filter((event) => event.type === "BROKER_RISK_BASELINE").length, 1);

  totalEvaluationAmount = 899_999;
  const restarted = service({ client: balanceClient, journal, commandIdFactory: () => "baseline-command-2" });
  await assert.rejects(
    () => restarted.submitOrder({ clientOrderId: "baseline-2", side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 70000 }),
    (error) => error.code === "KIS_PAPER_DAILY_LOSS_LIMIT",
  );
  assert.equal(restarted.status().killSwitch, true);
  assert.equal(journal.events.filter((event) => event.type === "BROKER_RISK_BASELINE").length, 1);
});

test("unknown result prevents kill switch from being manually cleared", () => {
  const timestamp = Date.parse("2026-08-01T09:00:00Z");
  const journal = new MemoryJournal([{ type: "BROKER_ORDER_COMMAND", timestamp, payload: { commandId: "c1", clientOrderId: "unknown-clear", operation: "SUBMIT", request: { quantity: 1 }, timestamp, day: "2026-08-01" } }]);
  const orders = service({ journal });
  assert.throws(
    () => orders.setKillSwitch(false),
    (error) => error.code === "KIS_PAPER_UNKNOWN_RESULT_UNRESOLVED",
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
    (error) => error.code === "KIS_PAPER_RESULT_JOURNAL_FAILED" && error.ambiguous === true,
  );
  assert.equal(broker.submitCalls, 1);
  assert.equal(orders.status().unknownResult, true);
  assert.equal(orders.status().killSwitch, true);
  const replay = await orders.submitOrder({ clientOrderId: "result-journal-1", side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 70000 });
  assert.equal(replay.status, "UNKNOWN_RESULT");
  assert.equal(replay.replayed, true);
  assert.equal(broker.submitCalls, 1);
});
