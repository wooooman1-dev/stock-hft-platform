import test from "node:test";
import assert from "node:assert/strict";
import { KisPaperAutoTrader } from "../domain/kisPaperAutoTrader.js";

const COST = { buyCommissionBps: 1.40527, sellCommissionBps: 1.40527, sellTaxBps: 20 };
const BASE = 1_789_000_000_000; // 임의 기준 시각

function fakeService(overrides = {}) {
  const submitted = [];
  return {
    submitted,
    status: () => ({
      killSwitch: false,
      unknownResult: false,
      reconciliation: { status: "CONSISTENT" },
      limits: { maxOrderQuantity: 10, maxOrderValue: 1_000_000 },
      ...overrides.status,
    }),
    async submitOrder(input) {
      submitted.push(input);
      if (overrides.throwOnSubmit) throw new Error("네트워크 실패");
      return { clientOrderId: input.clientOrderId, status: overrides.submitStatus ?? "ACCEPTED" };
    },
  };
}

function candidate(overrides = {}) {
  return {
    symbol: "005930",
    currentPrice: 70_000,
    price: { tickSize: 100 },
    microstructure: { spreadTicks: 1 },
    realtime: { state: "ENTRY_READY", currentPrice: 70_000, spreadBps: 14, latestAt: BASE },
    ...overrides,
  };
}

const balance = (cash = 10_000_000, positions = []) => ({
  positions,
  summary: { cash, totalEvaluationAmount: cash },
});

function trader(settings = {}, service = fakeService()) {
  return new KisPaperAutoTrader({
    orderService: service,
    settings: { enabled: true, ...settings },
    costModel: COST,
    now: () => BASE,
  });
}

test("기본으로 꺼져 있고 켜야만 주문을 낸다", async () => {
  const service = fakeService();
  const off = new KisPaperAutoTrader({ orderService: service, costModel: COST, now: () => BASE });
  const decision = await off.evaluate({ candidates: [candidate()], balance: balance() });
  assert.equal(decision.action, "DISABLED");
  assert.equal(service.submitted.length, 0);
});

test("ENTRY_READY이고 비용 문턱을 넘으면 시장가로 진입한다", async () => {
  const service = fakeService();
  const auto = trader({}, service);
  const decision = await auto.evaluate({ candidates: [candidate()], balance: balance() });

  assert.equal(decision.action, "ORDER");
  assert.equal(decision.side, "BUY");
  assert.equal(decision.reason, "ENTRY_SIGNAL");
  assert.equal(service.submitted.length, 1);
  const order = service.submitted[0];
  assert.equal(order.type, "MARKET", "v1은 시장가로 낸다");
  assert.equal(order.symbol, "005930");
  // 자본 1000만 × 10% = 100만, 한도 100만. 70,000원 → 14주지만 수량 한도 10주로 잘린다.
  assert.equal(order.quantity, 10);
});

test("ENTRY_READY가 아니면 진입하지 않는다", async () => {
  const service = fakeService();
  const auto = trader({}, service);
  const decision = await auto.evaluate({
    candidates: [candidate({ realtime: { state: "WATCH", currentPrice: 70_000, latestAt: BASE } })],
    balance: balance(),
  });
  assert.equal(decision.action, "SKIP");
  assert.equal(decision.evaluated[0].reason, "NOT_ENTRY_READY");
  assert.equal(service.submitted.length, 0);
});

test("비용 문턱을 못 넘으면 ENTRY_READY여도 진입하지 않는다", async () => {
  const service = fakeService();
  // 익절 150 - 고정비용 22.81 - 스프레드 100 - 슬리피지 14.3 = 12.9 < 문턱 50
  const auto = trader({ minimumNetEdgeBps: 50 }, service);
  const decision = await auto.evaluate({
    candidates: [candidate({ realtime: { state: "ENTRY_READY", currentPrice: 70_000, spreadBps: 100, latestAt: BASE } })],
    balance: balance(),
  });
  assert.equal(decision.action, "SKIP");
  assert.equal(decision.evaluated[0].reason, "BELOW_NET_EDGE");
  assert.ok(decision.evaluated[0].expectedNetEdgeBps < 50);
  assert.equal(service.submitted.length, 0);
});

test("시세가 오래되면 진입하지 않는다", async () => {
  const auto = trader({ staleQuoteMs: 5_000 });
  const decision = await auto.evaluate({
    candidates: [candidate({ realtime: { state: "ENTRY_READY", currentPrice: 70_000, spreadBps: 14, latestAt: BASE - 10_000 } })],
    balance: balance(),
  });
  assert.equal(decision.evaluated[0].reason, "STALE_QUOTE");
});

test("자본이 작아 1주도 못 사면 진입하지 않는다", async () => {
  const auto = trader({ positionSizeRatio: 0.1 });
  // 자본 30,000 × 10% = 3,000원 → 70,000원 주식 0주
  const decision = await auto.evaluate({ candidates: [candidate()], balance: balance(30_000) });
  assert.equal(decision.evaluated[0].reason, "QUANTITY_TOO_SMALL");
});

test("수량은 자본 비율로 정해지고 한도로 잘린다", async () => {
  const service = fakeService({ status: { limits: { maxOrderQuantity: 1_000, maxOrderValue: 1_000_000 } } });
  const auto = trader({ positionSizeRatio: 0.05 }, service);
  // 자본 1000만 × 5% = 50만 → 70,000원 기준 7주
  await auto.evaluate({ candidates: [candidate()], balance: balance() });
  assert.equal(service.submitted[0].quantity, 7);
});

test("쿨다운 중에는 진입하지 않는다", async () => {
  const service = fakeService();
  const auto = trader({ cooldownMs: 60_000 }, service);
  await auto.evaluate({ candidates: [candidate()], balance: balance() });
  const second = await auto.evaluate({ candidates: [candidate()], balance: balance() });
  assert.equal(second.action, "SKIP");
  assert.equal(second.reason, "COOLDOWN");
  assert.equal(service.submitted.length, 1);
});

test("손절 기준에 닿으면 보유 종목을 청산한다", async () => {
  const service = fakeService();
  const auto = trader({ stopLossBps: 100, forcedExitTime: null }, service);
  const held = [{ symbol: "005930", quantity: 5, averagePrice: 70_000, currentPrice: 69_000 }];
  const decision = await auto.evaluate({ candidates: [], balance: balance(1_000_000, held) });
  assert.equal(decision.action, "ORDER");
  assert.equal(decision.side, "SELL");
  assert.equal(decision.reason, "STOP_LOSS");
  assert.equal(service.submitted[0].quantity, 5);
});

test("보유 중이고 청산 조건이 없으면 유지한다", async () => {
  const service = fakeService();
  const auto = trader({ stopLossBps: 100, takeProfitBps: 150, forcedExitTime: null }, service);
  const held = [{ symbol: "005930", quantity: 5, averagePrice: 70_000, currentPrice: 70_050 }];
  const decision = await auto.evaluate({ candidates: [candidate()], balance: balance(1_000_000, held) });
  assert.equal(decision.action, "HOLD");
  assert.equal(service.submitted.length, 0);
});

test("강제 청산 시각을 지나면 보호 청산보다 먼저 정리한다", async () => {
  const service = fakeService();
  // KST 15:20 시점
  const kst1520 = Date.UTC(2026, 8, 11, 6, 20) ;
  const auto = new KisPaperAutoTrader({
    orderService: service,
    settings: { enabled: true, forcedExitTime: "15:15" },
    costModel: COST,
    now: () => kst1520,
  });
  const held = [{ symbol: "005930", quantity: 3, averagePrice: 70_000, currentPrice: 70_100 }];
  const decision = await auto.evaluate({ candidates: [], balance: balance(1_000_000, held) });
  assert.equal(decision.reason, "FORCED_EXIT");
  assert.equal(decision.side, "SELL");
  assert.equal(service.submitted[0].quantity, 3);
});

test("UNKNOWN_RESULT가 뜨면 멈추고 사람이 풀 때까지 주문하지 않는다", async () => {
  const service = fakeService({ submitStatus: "UNKNOWN_RESULT" });
  const auto = trader({ cooldownMs: 0 }, service);
  const first = await auto.evaluate({ candidates: [candidate()], balance: balance() });
  assert.equal(first.action, "ORDER");
  assert.equal(auto.status().halted, true);

  const second = await auto.evaluate({ candidates: [candidate()], balance: balance() });
  assert.equal(second.action, "HALTED");
  assert.equal(second.reason, "UNKNOWN_RESULT");
  assert.equal(service.submitted.length, 1, "멈춘 뒤에는 추가 주문이 나가면 안 된다");

  auto.clearHalt();
  const third = await auto.evaluate({ candidates: [candidate()], balance: balance() });
  assert.equal(third.action, "ORDER", "해제 후에는 다시 동작해야 한다");
});

test("대사 불일치와 킬 스위치에서도 멈춘다", async () => {
  for (const [label, status] of [
    ["대사 불일치", { reconciliation: { status: "MISMATCH" } }],
    ["킬 스위치", { killSwitch: true }],
  ]) {
    const service = fakeService({ status });
    const auto = trader({}, service);
    const decision = await auto.evaluate({ candidates: [candidate()], balance: balance() });
    assert.equal(decision.action, "HALTED", `${label}에서 멈춰야 한다`);
    assert.equal(service.submitted.length, 0);
  }
});

test("주문 제출이 실패하면 멈춘다", async () => {
  const service = fakeService({ throwOnSubmit: true });
  const auto = trader({}, service);
  const decision = await auto.evaluate({ candidates: [candidate()], balance: balance() });
  assert.equal(decision.action, "ORDER_ERROR");
  assert.equal(auto.status().halted, true);
});

test("clientOrderId는 규격을 지키고 주문마다 구분된다", async () => {
  const service = fakeService();
  const auto = trader({ cooldownMs: 0 }, service);
  await auto.evaluate({ candidates: [candidate()], balance: balance() });
  const id = service.submitted[0].clientOrderId;
  assert.match(id, /^[A-Za-z0-9._:-]{1,80}$/);
  assert.match(id, /^AUTO:BUY:005930:/);
});
