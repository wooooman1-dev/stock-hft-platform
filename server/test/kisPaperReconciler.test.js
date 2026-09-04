import assert from "node:assert/strict";
import test from "node:test";
import {
  KisPaperReconciler,
} from "../domain/kisPaperReconciler.js";
import { KisPaperOrderService } from "../integrations/kis/kisPaperOrderService.js";

class MemoryJournal {
  constructor(events = []) { this.events = structuredClone(events); }
  append(type, payload, timestamp) {
    const event = {
      sequence: this.events.length + 1,
      type,
      payload: structuredClone(payload),
      timestamp,
    };
    this.events.push(event);
    return structuredClone(event);
  }
  readAll() { return structuredClone(this.events); }
}

const NOW = Date.parse("2026-08-04T01:00:00Z");
const DAY = "2026-08-04";

function acceptedCommand({
  clientOrderId = "ui-buy-1",
  orderNumber = "0000010300",
  organizationNumber = "00950",
  side = "BUY",
  symbol = "005930",
  quantity = 1,
  timestamp = NOW - 60_000,
} = {}) {
  return {
    commandId: `command-${clientOrderId}`,
    clientOrderId,
    operation: "SUBMIT",
    request: { side, symbol, type: "MARKET", quantity, referencePrice: 235_000 },
    timestamp,
    day: DAY,
    state: "RESULT",
    result: {
      clientOrderId,
      operation: "SUBMIT",
      status: "ACCEPTED",
      replayed: false,
      result: {
        orderNumber,
        orderOrganizationNumber: organizationNumber,
      },
    },
    error: null,
  };
}

function brokerOrder({
  orderNumber = "0000010300",
  organizationNumber = "00950",
  side = "BUY",
  symbol = "005930",
  orderQuantity = 1,
  executedQuantity = 1,
  remainingQuantity = 0,
} = {}) {
  return {
    orderDate: "20260804",
    orderTime: "100000",
    orderNumber,
    orderOrganizationNumber: organizationNumber,
    symbol,
    name: "삼성전자",
    side,
    type: "MARKET",
    orderQuantity,
    executedQuantity,
    remainingQuantity,
    canceledQuantity: 0,
    rejectedQuantity: 0,
    status: remainingQuantity > 0 ? "OPEN" : "FILLED",
  };
}

function balance(quantity = 1) {
  return {
    fetchedAt: NOW,
    positions: quantity > 0
      ? [{ symbol: "005930", quantity, orderableQuantity: quantity }]
      : [],
    summary: { totalEvaluationAmount: 10_000_000, evaluationProfitLoss: 0 },
  };
}

function reconcileInput({ commands = [], orders = [], quantity = 0, cancelableOrders = [] } = {}) {
  return {
    commands: new Map(commands.map((command) => [command.clientOrderId, command])),
    orderHistory: { fetchedAt: NOW, orders },
    balance: balance(quantity),
    cancelableOrders,
  };
}

test("journal, KIS order history, and balance reconcile with a persisted opening-position baseline", () => {
  const journal = new MemoryJournal();
  const reconciler = new KisPaperReconciler({ journal, now: () => NOW });
  const report = reconciler.reconcile(reconcileInput({
    commands: [acceptedCommand()],
    orders: [brokerOrder()],
    quantity: 1,
  }));

  assert.equal(report.status, "CONSISTENT");
  assert.equal(report.blocked, false);
  assert.equal(report.summary.journalCommandCount, 1);
  assert.equal(report.summary.brokerOrderCount, 1);
  assert.deepEqual(report.baseline.openingPositions, [{ symbol: "005930", quantity: 0 }]);
  assert.equal(journal.events.filter((event) => event.type === "BROKER_RECONCILIATION_BASELINE").length, 1);
});

test("a KIS broker-only order latches a mismatch and blocks new orders", () => {
  const journal = new MemoryJournal();
  const reconciler = new KisPaperReconciler({ journal, now: () => NOW });
  const report = reconciler.reconcile(reconcileInput({
    orders: [brokerOrder()],
    quantity: 1,
  }));

  assert.equal(report.status, "MISMATCH");
  assert.equal(report.blocked, true);
  assert.equal(report.latched, true);
  assert.ok(report.issues.some((item) => item.code === "BROKER_ORDER_NOT_IN_JOURNAL"));
  assert.equal(journal.events.filter((event) => event.type === "BROKER_RECONCILIATION_MISMATCH").length, 1);
});

test("a resolved mismatch remains blocked until the user acknowledges it", () => {
  const journal = new MemoryJournal();
  const reconciler = new KisPaperReconciler({ journal, now: () => NOW });
  reconciler.reconcile(reconcileInput({ orders: [brokerOrder()], quantity: 1 }));

  const resolved = reconciler.reconcile(reconcileInput({
    commands: [acceptedCommand()],
    orders: [brokerOrder()],
    quantity: 1,
  }));
  assert.equal(resolved.status, "RESOLVED_AWAITING_ACK");
  assert.equal(resolved.rawStatus, "CONSISTENT");
  assert.equal(resolved.blocked, true);
  assert.equal(resolved.canAcknowledge, true);

  const acknowledged = reconciler.acknowledge();
  assert.equal(acknowledged.status, "CONSISTENT");
  assert.equal(acknowledged.blocked, false);
  assert.equal(journal.events.filter((event) => event.type === "BROKER_RECONCILIATION_ACKNOWLEDGED").length, 1);
});

test("a balance quantity that diverges from the persisted opening position and fills is blocked", () => {
  const journal = new MemoryJournal();
  const reconciler = new KisPaperReconciler({ journal, now: () => NOW });
  reconciler.reconcile(reconcileInput({
    commands: [acceptedCommand()],
    orders: [brokerOrder()],
    quantity: 1,
  }));

  const mismatch = reconciler.reconcile(reconcileInput({
    commands: [acceptedCommand()],
    orders: [brokerOrder()],
    quantity: 0,
  }));
  assert.equal(mismatch.status, "MISMATCH");
  assert.ok(mismatch.issues.some((item) => item.code === "POSITION_QUANTITY_MISMATCH"));
});

test("a newly accepted journal order receives a 30-second broker visibility grace period", () => {
  let clock = NOW;
  const journal = new MemoryJournal();
  const reconciler = new KisPaperReconciler({
    journal,
    now: () => clock,
    brokerVisibilityGraceMs: 30_000,
  });
  const command = acceptedCommand({ timestamp: NOW - 5_000 });
  const pending = reconciler.reconcile(reconcileInput({ commands: [command], quantity: 0 }));
  assert.equal(pending.status, "PENDING");
  assert.equal(pending.blocked, true);
  assert.equal(pending.latched, false);
  assert.ok(pending.pending.some((item) => item.code === "BROKER_ORDER_VISIBILITY_PENDING"));

  clock += 10_000;
  const consistent = reconciler.reconcile(reconcileInput({
    commands: [command],
    orders: [brokerOrder()],
    quantity: 1,
  }));
  assert.equal(consistent.status, "CONSISTENT");
  assert.equal(consistent.blocked, false);
});

test("order service blocks submit on reconciliation mismatch but still permits cancel", async () => {
  const journal = new MemoryJournal();
  const client = {
    submitCalls: 0,
    cancelCalls: 0,
    async getBalance() { return balance(1); },
    async getDailyOrders() { return { fetchedAt: NOW, orders: [brokerOrder()] }; },
    async getCancelableOrders() { return []; },
    async submitOrder() { this.submitCalls += 1; return { orderNumber: "2", orderOrganizationNumber: "00950" }; },
    async reviseOrder() { return { orderNumber: "3", orderOrganizationNumber: "00950" }; },
    async cancelOrder() { this.cancelCalls += 1; return { orderNumber: "4", orderOrganizationNumber: "00950" }; },
  };
  const service = new KisPaperOrderService({
    client,
    journal,
    limits: { maxOrderQuantity: 10, maxOrderValue: 1_000_000, maxDailyOrders: 20, maxDailyLoss: 0 },
    now: () => NOW,
    commandIdFactory: () => "command-1",
    reconciliationRefreshMs: 5_000,
  });

  await service.getBalance();
  assert.equal(service.status().reconciliation.status, "MISMATCH");
  assert.equal(service.status().killSwitch, true);
  await assert.rejects(
    () => service.submitOrder({
      clientOrderId: "blocked-buy",
      side: "BUY",
      symbol: "005930",
      type: "LIMIT",
      quantity: 1,
      limitPrice: 235_000,
    }),
    (error) => error.code === "KIS_PAPER_RECONCILIATION_BLOCKED",
  );
  assert.equal(client.submitCalls, 0);

  const cancel = await service.cancelOrder({
    clientOrderId: "safe-cancel",
    originalOrderNumber: "0000010300",
    orderOrganizationNumber: "00950",
    quantity: 1,
  });
  assert.equal(cancel.status, "ACCEPTED");
  assert.equal(client.cancelCalls, 1);
});

function acceptedReviseCommand({
  clientOrderId = "ui-revise-1",
  orderNumber = "0000010400",
  organizationNumber = "00950",
  quantity = 2,
  limitPrice = 236_000,
  timestamp = NOW - 60_000,
} = {}) {
  return {
    commandId: `command-${clientOrderId}`,
    clientOrderId,
    operation: "REVISE",
    request: {
      originalOrderNumber: "0000010300",
      orderOrganizationNumber: organizationNumber,
      type: "LIMIT",
      quantity,
      limitPrice,
      allQuantity: false,
    },
    timestamp,
    day: DAY,
    state: "RESULT",
    result: {
      clientOrderId,
      operation: "REVISE",
      status: "ACCEPTED",
      replayed: false,
      result: { orderNumber, orderOrganizationNumber: organizationNumber },
    },
    error: null,
  };
}

function acceptedCancelCommand({
  clientOrderId = "ui-cancel-1",
  orderNumber = "0000010500",
  organizationNumber = "00950",
  quantity = 1,
  timestamp = NOW - 60_000,
} = {}) {
  return {
    commandId: `command-${clientOrderId}`,
    clientOrderId,
    operation: "CANCEL",
    request: {
      originalOrderNumber: "0000010300",
      orderOrganizationNumber: organizationNumber,
      quantity,
      allQuantity: true,
    },
    timestamp,
    day: DAY,
    state: "RESULT",
    result: {
      clientOrderId,
      operation: "CANCEL",
      status: "ACCEPTED",
      replayed: false,
      result: { orderNumber, orderOrganizationNumber: organizationNumber },
    },
    error: null,
  };
}

test("a revise whose broker quantity or price diverges from the journal is a mismatch", () => {
  const journal = new MemoryJournal();
  const reconciler = new KisPaperReconciler({ journal, now: () => NOW });
  const command = acceptedReviseCommand();
  const revisedOrder = {
    orderDate: "20260804",
    orderTime: "100500",
    orderNumber: "0000010400",
    orderOrganizationNumber: "00950",
    symbol: "005930",
    name: "삼성전자",
    side: "BUY",
    type: "LIMIT",
    orderQuantity: 3,
    orderPrice: 236_000,
    executedQuantity: 0,
    remainingQuantity: 3,
    canceledQuantity: 0,
    rejectedQuantity: 0,
    canceled: false,
    status: "OPEN",
  };
  const report = reconciler.reconcile(reconcileInput({ commands: [command], orders: [revisedOrder], quantity: 0 }));
  assert.equal(report.status, "MISMATCH");
  assert.ok(report.issues.some((item) => item.code === "ORDER_REVISE_QUANTITY_MISMATCH"));
});

test("a revise whose broker quantity and price match the journal is consistent", () => {
  const journal = new MemoryJournal();
  const reconciler = new KisPaperReconciler({ journal, now: () => NOW });
  const command = acceptedReviseCommand();
  const revisedOrder = {
    orderDate: "20260804",
    orderTime: "100500",
    orderNumber: "0000010400",
    orderOrganizationNumber: "00950",
    symbol: "005930",
    name: "삼성전자",
    side: "BUY",
    type: "LIMIT",
    orderQuantity: 2,
    orderPrice: 236_000,
    executedQuantity: 0,
    remainingQuantity: 2,
    canceledQuantity: 0,
    rejectedQuantity: 0,
    canceled: false,
    status: "OPEN",
  };
  const report = reconciler.reconcile(reconcileInput({ commands: [command], orders: [revisedOrder], quantity: 0 }));
  assert.equal(report.status, "CONSISTENT");
});

test("an accepted cancel not yet reflected as canceled at the broker is pending, then a mismatch after the grace period", () => {
  let clock = NOW;
  const journal = new MemoryJournal();
  const reconciler = new KisPaperReconciler({ journal, now: () => clock, brokerVisibilityGraceMs: 30_000 });
  const command = acceptedCancelCommand({ timestamp: NOW - 5_000 });
  const openOrder = {
    orderDate: "20260804",
    orderTime: "100500",
    orderNumber: "0000010500",
    orderOrganizationNumber: "00950",
    symbol: "005930",
    name: "삼성전자",
    side: "BUY",
    type: "LIMIT",
    orderQuantity: 1,
    orderPrice: 235_000,
    executedQuantity: 0,
    remainingQuantity: 1,
    canceledQuantity: 0,
    rejectedQuantity: 0,
    canceled: false,
    status: "OPEN",
  };
  const pending = reconciler.reconcile(reconcileInput({ commands: [command], orders: [openOrder], quantity: 0 }));
  assert.equal(pending.status, "PENDING");
  assert.ok(pending.pending.some((item) => item.code === "ORDER_CANCEL_NOT_YET_REFLECTED"));

  clock += 40_000;
  const mismatch = reconciler.reconcile(reconcileInput({ commands: [command], orders: [openOrder], quantity: 0 }));
  assert.equal(mismatch.status, "MISMATCH");
  assert.ok(mismatch.issues.some((item) => item.code === "ORDER_CANCEL_NOT_REFLECTED"));
});

test("a cancel confirmed as canceled at the broker is consistent", () => {
  const journal = new MemoryJournal();
  const reconciler = new KisPaperReconciler({ journal, now: () => NOW });
  const command = acceptedCancelCommand();
  const canceledOrder = {
    orderDate: "20260804",
    orderTime: "100500",
    orderNumber: "0000010500",
    orderOrganizationNumber: "00950",
    symbol: "005930",
    name: "삼성전자",
    side: "BUY",
    type: "LIMIT",
    orderQuantity: 1,
    orderPrice: 235_000,
    executedQuantity: 0,
    remainingQuantity: 0,
    canceledQuantity: 1,
    rejectedQuantity: 0,
    canceled: true,
    status: "CANCELED",
  };
  const report = reconciler.reconcile(reconcileInput({ commands: [command], orders: [canceledOrder], quantity: 0 }));
  assert.equal(report.status, "CONSISTENT");
});
