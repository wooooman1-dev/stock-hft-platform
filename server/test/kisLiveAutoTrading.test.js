import assert from "node:assert/strict";
import test from "node:test";
import { KisLiveOrderService } from "../integrations/kis/kisLiveOrderService.js";
import { KisPaperAutoTrader } from "../domain/kisPaperAutoTrader.js";

// 2026-10-08 실전 자동매매: 같은 KisPaperAutoTrader를 실전 주문 서비스에 어댑터로 붙인다.
// 수동 주문은 1주 카나리 그대로, 자동 주문(automated)만 안전 한도로 제한하고, 보호 매도는 한도(LIMIT)
// 킬 스위치에서만 통과한다. 실전 KIS 호출은 전부 가짜 클라이언트다.

const COST = { buyCommissionBps: 1.40527, sellCommissionBps: 1.40527, sellTaxBps: 20 };
const BASE = Date.parse("2026-10-08T01:00:00Z"); // 10:00 KST
const AUTO_LIMITS = {
  maxOrderQuantity: 1_000, maxOrderValue: 200_000, maxDailyOrders: 30, maxDailyLoss: 50_000, maxConsecutiveLosses: 3,
};

class MemoryJournal {
  constructor() { this.events = []; }
  append(type, payload, timestamp) {
    const event = { sequence: this.events.length + 1, type, payload: structuredClone(payload), timestamp };
    this.events.push(event);
    return structuredClone(event);
  }
  readAll() { return structuredClone(this.events); }
}

function fakeClient(overrides = {}) {
  return {
    submitted: [],
    profitLoss: 0,
    async getBalance() { return { summary: { evaluationProfitLoss: this.profitLoss, totalEvaluationAmount: 10_000_000 } }; },
    async submitOrder(request) { this.submitted.push(request); return { status: "ACCEPTED", orderNumber: String(this.submitted.length) }; },
    async reviseOrder(request) { return { status: "ACCEPTED", request }; },
    async cancelOrder(request) { return { status: "ACCEPTED", request }; },
    ...overrides,
  };
}

function liveService({ client = fakeClient(), journal = new MemoryJournal(), limits = AUTO_LIMITS } = {}) {
  let sequence = 0;
  const service = new KisLiveOrderService({
    client,
    journal,
    limits,
    now: () => BASE,
    commandIdFactory: () => `command-${sequence += 1}`,
    costModel: COST,
  });
  return { service, client, journal };
}

const order = (overrides = {}) => ({
  clientOrderId: `order-${Math.random().toString(36).slice(2, 10)}`,
  side: "BUY", symbol: "005930", type: "MARKET", quantity: 5, referencePrice: 10_000, ...overrides,
});

test("수동 주문은 계속 정확히 1주 카나리이고, 자동 주문만 안전 한도 안에서 여러 주를 낼 수 있다", async () => {
  const { service, client } = liveService();
  await assert.rejects(() => service.submitOrder(order({ quantity: 5 })), (error) => error.code === "KIS_LIVE_CANARY_QUANTITY_LIMIT");
  const manualOne = await service.submitOrder(order({ quantity: 1 }));
  assert.equal(manualOne.status, "ACCEPTED");

  const automated = await service.submitOrder(order({ quantity: 5 }), { automated: true });
  assert.equal(automated.status, "ACCEPTED");
  assert.equal(client.submitted.at(-1).quantity, 5);
});

test("자동 주문도 주문 금액·수량 한도를 넘으면 거부된다", async () => {
  const { service, client } = liveService();
  // 30주 × 10,000원 = 300,000원 > 200,000원
  await assert.rejects(
    () => service.submitOrder(order({ quantity: 30 }), { automated: true }),
    (error) => error.code === "KIS_LIVE_ORDER_VALUE_LIMIT",
  );
  await assert.rejects(
    () => service.submitOrder(order({ quantity: 1_001, referencePrice: 10 }), { automated: true }),
    (error) => error.code === "KIS_LIVE_ORDER_QUANTITY_LIMIT",
  );
  assert.equal(client.submitted.length, 0);
});

test("HTTP 본문으로 automated·protectiveExit를 위조해도 수동 주문 규칙을 벗어나지 못한다", async () => {
  const { service, client } = liveService();
  await assert.rejects(
    () => service.submitOrder({ ...order({ quantity: 5 }), automated: true, protectiveExit: true }),
    (error) => error.code === "KIS_LIVE_CANARY_QUANTITY_LIMIT",
  );
  assert.equal(client.submitted.length, 0);
});

test("일 손실 한도로 켜진 킬 스위치에서는 신규 진입은 막히고 보호 매도는 통과한다", async () => {
  const { service, client } = liveService();
  client.profitLoss = -50_000;
  await assert.rejects(
    () => service.submitOrder(order({ quantity: 2 }), { automated: true }),
    (error) => error.code === "KIS_LIVE_DAILY_LOSS_LIMIT",
  );
  const status = service.status();
  assert.equal(status.killSwitch, true);
  assert.equal(status.killSwitchReason, "LIMIT");

  // 신규 매수는 계속 막힌다.
  await assert.rejects(
    () => service.submitOrder(order({ quantity: 2, protectiveExit: true }), { automated: true }),
    (error) => error.code === "KIS_LIVE_KILL_SWITCH",
    "매수는 protectiveExit를 붙여도 보호 매도가 아니다",
  );
  // 보호 매도 표시가 없는 매도도 막힌다.
  await assert.rejects(
    () => service.submitOrder(order({ side: "SELL", quantity: 2 }), { automated: true }),
    (error) => error.code === "KIS_LIVE_KILL_SWITCH",
  );
  // 한도(수량·금액)를 넘는 보유분도 보호 매도로는 나간다.
  const exit = await service.submitOrder(
    order({ side: "SELL", quantity: 300, referencePrice: 70_000, protectiveExit: true, reason: "STOP_LOSS" }),
    { automated: true },
  );
  assert.equal(exit.status, "ACCEPTED");
  assert.equal(client.submitted.at(-1).side, "SELL");
});

test("수동 킬 스위치와 주문 결과 불명에서는 보호 매도도 차단된다", async () => {
  const manual = liveService();
  manual.service.setKillSwitch(true);
  assert.equal(manual.service.status().killSwitchReason, "MANUAL");
  await assert.rejects(
    () => manual.service.submitOrder(order({ side: "SELL", quantity: 2, protectiveExit: true }), { automated: true }),
    (error) => error.code === "KIS_LIVE_KILL_SWITCH",
  );

  const unknown = liveService({
    client: fakeClient({
      async submitOrder() {
        const error = new Error("timeout");
        error.code = "TIMEOUT";
        error.ambiguous = true;
        throw error;
      },
    }),
  });
  const first = await unknown.service.submitOrder(order({ quantity: 2 }), { automated: true });
  assert.equal(first.status, "UNKNOWN_RESULT");
  await assert.rejects(
    () => unknown.service.submitOrder(order({ side: "SELL", quantity: 2, protectiveExit: true }), { automated: true }),
    (error) => error.code === "KIS_LIVE_KILL_SWITCH",
  );
});

test("수동 킬 스위치를 해제하면 사유도 지워진다", () => {
  const { service } = liveService();
  service.setKillSwitch(true);
  service.setKillSwitch(false);
  assert.equal(service.status().killSwitch, false);
  assert.equal(service.status().killSwitchReason, null);
});

test("주문 사유와 진단 메모(context)가 명령 저널에 남고 KIS 요청에는 들어가지 않는다", async () => {
  const { service, client, journal } = liveService();
  await service.submitOrder(order({ quantity: 2, reason: "ENTRY_SIGNAL", context: { gate: { readyMs: 31_000 } } }), { automated: true });
  const command = journal.events.find((event) => event.type === "BROKER_ORDER_COMMAND").payload;
  assert.equal(command.reason, "ENTRY_SIGNAL");
  assert.deepEqual(command.context, { gate: { readyMs: 31_000 } });
  assert.equal("reason" in client.submitted[0], false);
  assert.equal("context" in client.submitted[0], false);
});

// ── 자동매매기 + 실전 주문 서비스 통합 ─────────────────────────────────────────────────

function liveTrader({ service, settings = {}, exchange = "KRX" } = {}) {
  const adapter = {
    submitOrder: (input) => service.submitOrder(input, { automated: true }),
    getBalance: () => service.getBalance(),
    getPerformance: (options) => service.getPerformance(options),
    status: () => service.status(),
    journal: service.journal,
  };
  return new KisPaperAutoTrader({
    orderService: adapter,
    settings: { enabled: true, settlementGraceMs: 0, entryConfirmMs: 0, stopConfirmMs: 0, maxConcurrentPositions: 3, ...settings },
    costModel: COST,
    now: () => BASE,
    exchange,
  });
}

const readyCandidate = () => ({
  symbol: "005930",
  currentPrice: 70_000,
  price: { tickSize: 100 },
  microstructure: { spreadTicks: 1 },
  realtime: {
    state: "ENTRY_READY",
    latestAt: BASE,
    metrics: { currentPrice: 70_000, spreadBps: 14, executionStrength: 110, vwapExtensionBps: 20 },
  },
});

const account = (positions = []) => ({ positions, summary: { cash: 10_000_000, totalEvaluationAmount: 10_000_000 } });

test("실전 자동매매 진입은 KRX로, 종목당 최대 주문금액(20만원) 안에서 낸다", async () => {
  const { service, client } = liveService();
  const auto = liveTrader({ service });
  const decision = await auto.evaluate({ candidates: [readyCandidate()], balance: account() });
  assert.equal(decision.action, "ORDER");
  assert.equal(decision.side, "BUY");
  const sent = client.submitted[0];
  assert.equal(sent.exchange, "KRX");
  // 자본 1,000만원 × 10% = 100만원이지만 maxOrderValue 20만원이 먼저 제한한다: 70,000원 → 2주.
  assert.equal(sent.quantity, 2);
});

test("실전 자동매매 손절 매도는 일 손실 한도로 킬 스위치가 켜져 있어도 나간다", async () => {
  const { service, client } = liveService();
  client.profitLoss = -50_000;
  // 신규 주문 시도가 일 손실 한도를 확인하면서 킬 스위치(LIMIT)를 켠다.
  await assert.rejects(
    () => service.submitOrder(order({ quantity: 2 }), { automated: true }),
    (error) => error.code === "KIS_LIVE_DAILY_LOSS_LIMIT",
  );
  assert.equal(service.status().killSwitch, true);

  const auto = liveTrader({ service, settings: { stopLossBps: 300 } });
  // 3주 보유, 평균 70,000 → 현재 65,000(-714bp): 손절 조건(−300bp)을 넘었다.
  const held = [{ symbol: "005930", quantity: 3, averagePrice: 70_000, currentPrice: 65_000 }];
  const decision = await auto.evaluate({ candidates: [], balance: account(held) });
  assert.equal(decision.action, "ORDER");
  assert.equal(decision.side, "SELL");
  assert.equal(decision.reason, "STOP_LOSS");
  assert.equal(decision.status, "ACCEPTED");
  assert.equal(client.submitted.at(-1).side, "SELL");
  assert.equal(client.submitted.at(-1).exchange, "KRX");
  assert.equal(auto.status().halted, true, "킬 스위치가 켜져 있으니 신규 진입은 멈춘 상태로 남는다");
});

test("exchange 옵션은 SOR·KRX·NXT만 받는다", () => {
  const { service } = liveService();
  assert.throws(() => liveTrader({ service, exchange: "ALL" }), TypeError);
});
