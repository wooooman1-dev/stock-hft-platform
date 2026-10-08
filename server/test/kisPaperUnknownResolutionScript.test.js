import assert from "node:assert/strict";
import test from "node:test";
import {
  KisPaperUnknownResolutionError,
  parseArguments,
  runKisPaperUnknownResolution,
} from "../../scripts/resolve-kis-paper-unknown.js";

const NOW = Date.parse("2026-08-21T01:30:00Z");

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function unknownCommand() {
  return {
    clientOrderId: "crash-1",
    commandId: "command-1",
    operation: "SUBMIT",
    day: "2026-08-21",
    timestamp: NOW,
    request: { side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 200_000, exchange: "KRX" },
    error: { code: "KIS_PAPER_INTERRUPTED_COMMAND", message: "재시작 전 결과 미기록" },
  };
}

function brokerOrder(overrides = {}) {
  return {
    orderNumber: "0000017975",
    orderOrganizationNumber: "00950",
    originalOrderNumber: "0000000000",
    symbol: "005930",
    side: "BUY",
    orderQuantity: 1,
    executedQuantity: 0,
    remainingQuantity: 1,
    orderPrice: 200_000,
    status: "OPEN",
    ...overrides,
  };
}

function createFakeServer({
  unknownCommands = [unknownCommand()],
  orders = [brokerOrder()],
  trackedOrderNumbers = [],
  resolveStatus = 200,
  resolveBody = null,
} = {}) {
  const calls = [];
  let resolved = false;

  const status = () => ({
    enabled: true,
    environment: "PAPER",
    orderApiAvailable: true,
    service: {
      killSwitch: !resolved,
      unknownResult: !resolved,
      unknownCommands: resolved ? [] : structuredClone(unknownCommands),
      trackedOrderNumbers: structuredClone(trackedOrderNumbers),
      reconciliation: { status: resolved ? "RESOLVED_AWAITING_ACK" : "MISMATCH", blocked: true },
    },
  });

  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method, pathname: url.pathname, body });

    if (method === "GET" && url.pathname === "/api/kis/paper/status") return response(status());
    if (method === "GET" && url.pathname === "/api/snapshot") {
      return response({ symbol: "005930", account: { orders: structuredClone(orders) } });
    }
    if (method === "POST" && url.pathname === "/api/kis/paper/orders/resolve-unknown") {
      if (resolveStatus !== 200) {
        return response(resolveBody ?? { error: "차단됨", code: "KIS_PAPER_UNKNOWN_RESOLUTION_ORDER_NOT_FOUND" }, resolveStatus);
      }
      resolved = true;
      return response({
        clientOrderId: body.clientOrderId,
        operation: "SUBMIT",
        resolution: body.resolution,
        resolvedAt: NOW,
        matchedOrder: body.resolution === "ACCEPTED" ? brokerOrder() : null,
        status: status(),
      });
    }
    return response({ error: "not found" }, 404);
  };

  return { fetchImpl, calls };
}

test("listing mode reports every unknown command with its matching broker orders", async () => {
  const server = createFakeServer();
  const report = await runKisPaperUnknownResolution({
    fetchImpl: server.fetchImpl,
    now: () => NOW,
    logger: {},
  });
  assert.equal(report.status, "REVIEW");
  assert.deepEqual(report.unknownCommands.map((command) => command.clientOrderId), ["crash-1"]);
  assert.deepEqual(report.candidates[0].brokerOrders.map((order) => order.orderNumber), ["0000017975"]);
  assert.match(report.guidance, /--resolution=ACCEPTED\|NOT_ACCEPTED/);
  assert.match(report.guidance, /주문내역과 직접 대조/);
  assert.ok(server.calls.every((call) => call.method === "GET"));
});

test("orders already owned by another journal command are not offered as candidates", async () => {
  const server = createFakeServer({
    orders: [brokerOrder(), brokerOrder({ orderNumber: "0000017619" })],
    trackedOrderNumbers: ["0000017619"],
  });
  const report = await runKisPaperUnknownResolution({
    fetchImpl: server.fetchImpl,
    now: () => NOW,
    logger: {},
  });
  assert.deepEqual(report.candidates[0].brokerOrders.map((order) => order.orderNumber), ["0000017975"]);
});

test("nothing to resolve is reported without touching the resolution endpoint", async () => {
  const server = createFakeServer({ unknownCommands: [] });
  const report = await runKisPaperUnknownResolution({
    fetchImpl: server.fetchImpl,
    now: () => NOW,
    logger: {},
  });
  assert.equal(report.status, "NONE");
  assert.deepEqual(report.unknownCommands, []);
  assert.equal(server.calls.filter((call) => call.method === "POST").length, 0);
});

test("confirmed acceptance is posted with the broker order number the user verified", async () => {
  const server = createFakeServer();
  const report = await runKisPaperUnknownResolution({
    fetchImpl: server.fetchImpl,
    clientOrderId: "crash-1",
    resolution: "accepted",
    brokerOrderNumber: "0000017975",
    orderOrganizationNumber: "00950",
    note: "주문내역 대조 완료",
    now: () => NOW,
    logger: {},
  });
  assert.equal(report.status, "RESOLVED");
  assert.equal(report.resolution, "ACCEPTED");
  assert.equal(report.matchedOrder.orderNumber, "0000017975");
  assert.deepEqual(report.remainingUnknownCommands, []);
  assert.equal(report.unknownResult, false);
  const post = server.calls.find((call) => call.method === "POST");
  assert.deepEqual(post.body, {
    clientOrderId: "crash-1",
    resolution: "ACCEPTED",
    brokerOrderNumber: "0000017975",
    orderOrganizationNumber: "00950",
    note: "주문내역 대조 완료",
  });
});

test("acceptance without a broker order number never reaches the server", async () => {
  const server = createFakeServer();
  await assert.rejects(
    () => runKisPaperUnknownResolution({
      fetchImpl: server.fetchImpl,
      clientOrderId: "crash-1",
      resolution: "ACCEPTED",
      now: () => NOW,
      logger: {},
    }),
    (error) => error instanceof KisPaperUnknownResolutionError
      && error.code === "KIS_PAPER_UNKNOWN_RESOLUTION_ORDER_NUMBER_REQUIRED",
  );
  assert.equal(server.calls.filter((call) => call.method === "POST").length, 0);
});

test("an unknown clientOrderId is rejected before any resolution request", async () => {
  const server = createFakeServer();
  await assert.rejects(
    () => runKisPaperUnknownResolution({
      fetchImpl: server.fetchImpl,
      clientOrderId: "other-1",
      resolution: "NOT_ACCEPTED",
      now: () => NOW,
      logger: {},
    }),
    (error) => error.code === "KIS_PAPER_UNKNOWN_COMMAND_NOT_FOUND",
  );
  assert.equal(server.calls.filter((call) => call.method === "POST").length, 0);
});

test("server side refusal keeps its own code", async () => {
  const server = createFakeServer({ resolveStatus: 409 });
  await assert.rejects(
    () => runKisPaperUnknownResolution({
      fetchImpl: server.fetchImpl,
      clientOrderId: "crash-1",
      resolution: "NOT_ACCEPTED",
      now: () => NOW,
      logger: {},
    }),
    (error) => error.code === "KIS_PAPER_UNKNOWN_RESOLUTION_ORDER_NOT_FOUND",
  );
});

test("a disabled paper order API stops the reconciliation helper", async () => {
  const fetchImpl = async () => response({ enabled: false, environment: "PAPER", orderApiAvailable: false });
  await assert.rejects(
    () => runKisPaperUnknownResolution({ fetchImpl, now: () => NOW, logger: {} }),
    (error) => error.code === "KIS_PAPER_UNKNOWN_RESOLUTION_ORDER_API_DISABLED",
  );
});

test("command line flags map to the resolution options", () => {
  const options = parseArguments([
    "--client-order-id=crash-1",
    "--resolution=NOT_ACCEPTED",
    "--broker-order-number=0000017975",
    "--order-organization-number=00950",
    "--note=대조 완료",
  ]);
  assert.equal(options.clientOrderId, "crash-1");
  assert.equal(options.resolution, "NOT_ACCEPTED");
  assert.equal(options.brokerOrderNumber, "0000017975");
  assert.equal(options.orderOrganizationNumber, "00950");
  assert.equal(options.note, "대조 완료");
});
