import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { KisPaperOrderService } from "../integrations/kis/kisPaperOrderService.js";

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");

const NOW = Date.parse("2026-08-01T09:00:00Z");
const DAY = "2026-08-01";

class MemoryJournal {
  constructor(events = []) { this.events = structuredClone(events); }
  append(type, payload, timestamp) {
    const event = { sequence: this.events.length + 1, type, payload: structuredClone(payload), timestamp };
    this.events.push(event);
    return structuredClone(event);
  }
  readAll() { return structuredClone(this.events); }
  types() { return this.events.map((event) => event.type); }
  last(type) { return [...this.events].reverse().find((event) => event.type === type) ?? null; }
}

function brokerOrder(overrides = {}) {
  return {
    source: "KIS",
    mode: "PAPER_TRADING",
    environment: "PAPER",
    orderDate: "20260801",
    orderTime: "180001",
    orderedAt: NOW,
    orderOrganizationNumber: "00950",
    orderNumber: "0000017975",
    originalOrderNumber: "0000000000",
    symbol: "005930",
    name: "삼성전자",
    side: "BUY",
    type: "LIMIT",
    orderQuantity: 1,
    orderPrice: 200_000,
    executedQuantity: 0,
    remainingQuantity: 1,
    canceledQuantity: 0,
    canceled: false,
    status: "OPEN",
    exchange: "KRX",
    ...overrides,
  };
}

function client({ orders = [], ...overrides } = {}) {
  return {
    submitCalls: 0,
    dailyOrderCalls: 0,
    async getBalance() { return { summary: { evaluationProfitLoss: 0 }, positions: [] }; },
    async getDailyOrders() {
      this.dailyOrderCalls += 1;
      return { source: "KIS", fetchedAt: NOW, orders: structuredClone(orders), summary: {} };
    },
    async getCancelableOrders() { return []; },
    async submitOrder(request) { this.submitCalls += 1; return { status: "ACCEPTED", orderNumber: "1", request }; },
    async reviseOrder(request) { return { status: "ACCEPTED", orderNumber: "2", request }; },
    async cancelOrder(request) { return { status: "ACCEPTED", orderNumber: "3", request }; },
    ...overrides,
  };
}

function interruptedJournal(request = { side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 200_000, exchange: "KRX" }) {
  return new MemoryJournal([{
    sequence: 1,
    type: "BROKER_ORDER_COMMAND",
    timestamp: NOW,
    payload: {
      commandId: "command-1",
      clientOrderId: "crash-1",
      operation: "SUBMIT",
      request,
      timestamp: NOW,
      day: DAY,
    },
  }]);
}

function service({ journal, client: broker }) {
  return new KisPaperOrderService({
    client: broker,
    journal,
    limits: { maxOrderQuantity: 10, maxOrderValue: 1_000_000, maxDailyOrders: 20, maxDailyLoss: 100_000 },
    now: () => NOW,
    commandIdFactory: () => "command-2",
  });
}

const SUBMIT_INPUT = {
  clientOrderId: "crash-1",
  side: "BUY",
  symbol: "005930",
  type: "LIMIT",
  quantity: 1,
  limitPrice: 200_000,
  exchange: "KRX",
};

test("unknown commands are listed with the request the user must reconcile", () => {
  const orders = service({ journal: interruptedJournal(), client: client() });
  const status = orders.status();
  assert.equal(status.unknownResult, true);
  assert.equal(status.killSwitch, true);
  assert.deepEqual(status.unknownCommands.map((command) => command.clientOrderId), ["crash-1"]);
  assert.equal(status.unknownCommands[0].request.symbol, "005930");
  assert.deepEqual(status.trackedOrderNumbers, []);
});

test("resolved commands publish the broker order number they now own", async () => {
  const orders = service({ journal: interruptedJournal(), client: client({ orders: [brokerOrder()] }) });
  await orders.resolveUnknownResult({
    clientOrderId: "crash-1",
    resolution: "ACCEPTED",
    brokerOrderNumber: "0000017975",
  });
  assert.deepEqual(orders.status().trackedOrderNumbers, ["0000017975"]);
});

test("confirming broker acceptance journals the resolution and replays the accepted order", async () => {
  const journal = interruptedJournal();
  const broker = client({ orders: [brokerOrder()] });
  const orders = service({ journal, client: broker });

  const resolved = await orders.resolveUnknownResult({
    clientOrderId: "crash-1",
    resolution: "ACCEPTED",
    brokerOrderNumber: "0000017975",
    orderOrganizationNumber: "00950",
    note: "KIS 주문내역에서 미체결 1주 확인",
  });

  assert.equal(resolved.resolution, "ACCEPTED");
  assert.equal(resolved.matchedOrder.orderNumber, "0000017975");
  assert.equal(orders.status().unknownResult, false);
  assert.deepEqual(orders.status().unknownCommands, []);

  const event = journal.last("BROKER_ORDER_UNKNOWN_RESOLVED");
  assert.equal(event.payload.clientOrderId, "crash-1");
  assert.equal(event.payload.resolution, "ACCEPTED");
  assert.equal(event.payload.note, "KIS 주문내역에서 미체결 1주 확인");
  assert.equal(event.payload.evidence.matchedOrder.orderNumber, "0000017975");

  const replay = await orders.submitOrder(SUBMIT_INPUT);
  assert.equal(replay.status, "ACCEPTED");
  assert.equal(replay.replayed, true);
  assert.equal(replay.result.orderNumber, "0000017975");
  assert.equal(replay.result.resolvedFromBrokerHistory, true);
  assert.equal(broker.submitCalls, 0);
});

test("acceptance cannot be confirmed with an order number the broker history does not show", async () => {
  const orders = service({ journal: interruptedJournal(), client: client({ orders: [] }) });
  await assert.rejects(
    () => orders.resolveUnknownResult({
      clientOrderId: "crash-1",
      resolution: "ACCEPTED",
      brokerOrderNumber: "0000017975",
    }),
    (error) => error.code === "KIS_PAPER_UNKNOWN_RESOLUTION_ORDER_NOT_FOUND",
  );
  assert.equal(orders.status().unknownResult, true);
});

test("acceptance cannot be confirmed with a broker order that contradicts the journal command", async () => {
  const orders = service({
    journal: interruptedJournal(),
    client: client({ orders: [brokerOrder({ symbol: "000660", orderQuantity: 5 })] }),
  });
  await assert.rejects(
    () => orders.resolveUnknownResult({
      clientOrderId: "crash-1",
      resolution: "ACCEPTED",
      brokerOrderNumber: "0000017975",
    }),
    (error) => error.code === "KIS_PAPER_UNKNOWN_RESOLUTION_ORDER_CONFLICT",
  );
  assert.equal(orders.status().unknownResult, true);
});

test("a matching untracked broker order blocks a NOT_ACCEPTED confirmation", async () => {
  const orders = service({ journal: interruptedJournal(), client: client({ orders: [brokerOrder()] }) });
  await assert.rejects(
    () => orders.resolveUnknownResult({ clientOrderId: "crash-1", resolution: "NOT_ACCEPTED" }),
    (error) => error.code === "KIS_PAPER_UNKNOWN_RESOLUTION_CANDIDATE_EXISTS",
  );
  assert.equal(orders.status().unknownResult, true);
});

test("confirming the broker never accepted the command replays a rejection instead of reordering", async () => {
  const journal = interruptedJournal();
  const broker = client({ orders: [] });
  const orders = service({ journal, client: broker });

  const resolved = await orders.resolveUnknownResult({ clientOrderId: "crash-1", resolution: "NOT_ACCEPTED" });
  assert.equal(resolved.resolution, "NOT_ACCEPTED");
  assert.equal(resolved.matchedOrder, null);
  assert.equal(orders.status().unknownResult, false);

  const replay = await orders.submitOrder(SUBMIT_INPUT);
  assert.equal(replay.status, "REJECTED");
  assert.equal(replay.replayed, true);
  assert.equal(replay.error.code, "KIS_PAPER_UNKNOWN_RESOLVED_NOT_ACCEPTED");
  assert.equal(broker.submitCalls, 0);
});

test("resolution survives a restart and does not latch the kill switch again", async () => {
  const journal = interruptedJournal();
  const first = service({ journal, client: client({ orders: [brokerOrder()] }) });
  await first.resolveUnknownResult({
    clientOrderId: "crash-1",
    resolution: "ACCEPTED",
    brokerOrderNumber: "0000017975",
  });

  const broker = client({ orders: [brokerOrder()] });
  const restarted = service({ journal, client: broker });
  const status = restarted.status();
  assert.equal(status.unknownResult, false);
  assert.equal(status.manualKillSwitch, false);
  const replay = await restarted.submitOrder(SUBMIT_INPUT);
  assert.equal(replay.status, "ACCEPTED");
  assert.equal(replay.replayed, true);
  assert.equal(broker.submitCalls, 0);
});

test("kill switch stays latched until the user resolves the unknown command", async () => {
  const journal = interruptedJournal();
  const orders = service({ journal, client: client({ orders: [brokerOrder()] }) });
  await orders.refreshReconciliation({ force: true });
  assert.throws(
    () => orders.setKillSwitch(false),
    (error) => error.code === "KIS_PAPER_UNKNOWN_RESULT_UNRESOLVED",
  );

  await orders.resolveUnknownResult({
    clientOrderId: "crash-1",
    resolution: "ACCEPTED",
    brokerOrderNumber: "0000017975",
  });
  const released = orders.setKillSwitch(false);
  assert.equal(released.killSwitch, false);
  assert.ok(journal.types().includes("BROKER_RECONCILIATION_ACKNOWLEDGED"));
});

test("resolution is refused for commands that already have a broker result", async () => {
  const broker = client({ orders: [] });
  const orders = service({ journal: new MemoryJournal(), client: broker });
  await orders.submitOrder({ ...SUBMIT_INPUT, clientOrderId: "done-1" });
  await assert.rejects(
    () => orders.resolveUnknownResult({
      clientOrderId: "done-1",
      resolution: "ACCEPTED",
      brokerOrderNumber: "0000017975",
    }),
    (error) => error.code === "KIS_PAPER_COMMAND_NOT_UNKNOWN",
  );
});

test("resolution requires an explicit ACCEPTED or NOT_ACCEPTED decision", async () => {
  const orders = service({ journal: interruptedJournal(), client: client({ orders: [] }) });
  await assert.rejects(
    () => orders.resolveUnknownResult({ clientOrderId: "crash-1", resolution: "MAYBE" }),
    (error) => error.code === "KIS_PAPER_UNKNOWN_RESOLUTION_INVALID",
  );
  await assert.rejects(
    () => orders.resolveUnknownResult({ clientOrderId: "missing-1", resolution: "NOT_ACCEPTED" }),
    (error) => error.code === "KIS_PAPER_UNKNOWN_COMMAND_NOT_FOUND",
  );
});

test("resolution stops when the broker order history cannot be read", async () => {
  const orders = service({
    journal: interruptedJournal(),
    client: client({
      orders: [],
      async getDailyOrders() { throw new Error("network down"); },
    }),
  });
  await assert.rejects(
    () => orders.resolveUnknownResult({ clientOrderId: "crash-1", resolution: "NOT_ACCEPTED" }),
    (error) => error.code === "KIS_PAPER_UNKNOWN_RESOLUTION_EVIDENCE_UNAVAILABLE",
  );
  assert.equal(orders.status().unknownResult, true);
});

test("the resolution endpoint is loopback only and routed through the main workspace", () => {
  assert.match(appSource, /\/api\/kis\/paper\/orders\/resolve-unknown/);
  const route = appSource.slice(appSource.indexOf('url.pathname === "/api/kis/paper/orders/resolve-unknown"'));
  const handler = route.slice(0, route.indexOf("}\r\n") + 1);
  assert.match(handler, /rejectNonLoopbackKisRequest/);
  assert.match(handler, /mainWorkspace\.resolveUnknownOrder/);
});
