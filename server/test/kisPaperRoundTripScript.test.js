import assert from "node:assert/strict";
import test from "node:test";
import {
  KisPaperRoundTripError,
  koreaMarketWindow,
  runKisPaperRoundTrip,
} from "../../scripts/verify-kis-paper-roundtrip.js";

const MARKET_TIME = Date.parse("2026-08-03T00:30:00Z");

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createFakeServer({ fillBuy = true, fillSell = true } = {}) {
  let quantity = 0;
  let cash = 10_000_000;
  let equity = 10_000_000;
  let killSwitch = false;
  const commands = [];
  const calls = [];

  const snapshot = () => ({
    symbol: "005930",
    symbolName: "삼성전자",
    timestamp: MARKET_TIME,
    lastPrice: 240_000,
    riskLimits: {
      maxOrderQuantity: 10,
      maxOrderValue: 3_000_000,
      maxDailyOrders: 20,
      maxDailyLoss: 100_000,
    },
    system: {
      accountMode: "KIS_PAPER_TRADING",
      killSwitch,
      unknownResult: false,
    },
    account: {
      available: true,
      equity,
      availableCash: cash,
      openOrderCount: 0,
      reservedSellQuantity: 0,
      sellableQuantity: quantity,
      unrealizedPnl: 0,
      position: {
        quantity,
        averagePrice: quantity ? 240_000 : null,
        currentPrice: quantity ? 240_000 : null,
      },
      commands: structuredClone(commands),
    },
  });

  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method ?? "GET";
    calls.push({ method, pathname: url.pathname, body: options.body ?? null });

    if (method === "GET" && url.pathname === "/health") {
      return response({
        status: "ok",
        kisPaper: {
          enabled: true,
          orderApiAvailable: true,
          killSwitch,
          unknownResult: false,
        },
      });
    }
    if (method === "GET" && url.pathname === "/api/snapshot") {
      return response(snapshot());
    }
    if (method === "POST" && url.pathname === "/api/kis/main/refresh") {
      return response(snapshot());
    }
    if (method === "POST" && url.pathname === "/api/kis/paper/kill-switch") {
      killSwitch = Boolean(JSON.parse(options.body).enabled);
      return response({ killSwitch });
    }
    if (method === "POST" && url.pathname === "/api/kis/paper/orders") {
      const request = JSON.parse(options.body);
      const result = {
        clientOrderId: request.clientOrderId,
        operation: "SUBMIT",
        status: "ACCEPTED",
        replayed: false,
        result: {
          orderNumber: request.side === "BUY" ? "BUY-1" : "SELL-1",
          orderOrganizationNumber: "00950",
          orderTime: request.side === "BUY" ? "093001" : "093002",
        },
      };
      commands.unshift({
        id: request.clientOrderId,
        at: MARKET_TIME,
        operation: "SUBMIT",
        request,
        response: structuredClone(result),
      });
      if (request.side === "BUY" && fillBuy) {
        quantity += request.quantity;
        cash -= request.quantity * 240_000;
        equity -= 100;
      }
      if (request.side === "SELL" && fillSell) {
        quantity -= request.quantity;
        cash += request.quantity * 239_900;
        equity -= 100;
      }
      return response(result);
    }
    return response({ error: "not found" }, 404);
  };

  return {
    fetchImpl,
    calls,
    get killSwitch() { return killSwitch; },
  };
}

test("Korea market window allows guarded weekday trading hours", () => {
  assert.equal(koreaMarketWindow(MARKET_TIME).allowed, true);
  assert.equal(koreaMarketWindow(Date.parse("2026-08-02T00:30:00Z")).allowed, false);
  assert.equal(koreaMarketWindow(Date.parse("2026-08-03T07:30:00Z")).allowed, false);
});

test("round-trip verifier confirms buy, sell, restored quantity and server journal commands", async () => {
  const fake = createFakeServer();
  let id = 0;
  const report = await runKisPaperRoundTrip({
    fetchImpl: fake.fetchImpl,
    now: () => MARKET_TIME,
    sleepFn: async () => {},
    idFactory: () => `id-${++id}`,
    logger: { info() {} },
  });

  assert.equal(report.status, "PASS");
  assert.equal(report.before.quantity, 0);
  assert.equal(report.afterBuy.quantity, 1);
  assert.equal(report.after.quantity, 0);
  assert.equal(report.buy.status, "ACCEPTED");
  assert.equal(report.sell.status, "ACCEPTED");
  assert.equal(report.verified.finalPositionRestored, true);
  assert.equal(report.verified.buyJournalCommandRestored, true);
  assert.equal(report.verified.sellJournalCommandRestored, true);
  assert.equal(fake.killSwitch, false);
});

test("round-trip verifier refuses to send an order outside the guarded market window", async () => {
  let fetchCount = 0;
  await assert.rejects(
    () => runKisPaperRoundTrip({
      fetchImpl: async () => {
        fetchCount += 1;
        throw new Error("must not fetch");
      },
      now: () => Date.parse("2026-08-03T07:30:00Z"),
      logger: { info() {} },
    }),
    (error) => error instanceof KisPaperRoundTripError
      && error.code === "KIS_PAPER_ROUNDTRIP_OUTSIDE_MARKET_WINDOW",
  );
  assert.equal(fetchCount, 0);
});

test("round-trip verifier activates the paper kill switch when buy is accepted but not confirmed", async () => {
  const fake = createFakeServer({ fillBuy: false });
  let clock = MARKET_TIME;
  let id = 0;
  await assert.rejects(
    () => runKisPaperRoundTrip({
      fetchImpl: fake.fetchImpl,
      timeoutMs: 1_000,
      pollIntervalMs: 100,
      now: () => clock,
      sleepFn: async (milliseconds) => { clock += milliseconds; },
      idFactory: () => `id-${++id}`,
      logger: { info() {} },
    }),
    (error) => error instanceof KisPaperRoundTripError
      && error.code === "KIS_PAPER_ROUNDTRIP_INCOMPLETE_AFTER_BUY",
  );
  assert.equal(fake.killSwitch, true);
  assert.ok(fake.calls.some((call) => call.pathname === "/api/kis/paper/kill-switch"));
});
