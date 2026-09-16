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
    // 정산 대기는 기본으로 꺼 각 테스트가 겨냥한 게이트만 검증한다.
    // 정산 대기 자체는 전용 테스트에서 명시적으로 켠다.
    settings: { enabled: true, settlementGraceMs: 0, ...settings },
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

// 2026-09-11 사고: 대사 불일치로 멈춘 뒤 3시간 동안 4주가 손절·익절·강제청산
// 없이 방치됐다. 멈춤은 신규 진입만 막아야 한다.
test("멈춘 상태에서도 보호 청산은 계속 평가한다", async () => {
  const service = fakeService({ status: { reconciliation: { status: "MISMATCH" } } });
  const auto = trader({ stopLossBps: 100, forcedExitTime: null }, service);
  const held = [{ symbol: "005930", quantity: 5, averagePrice: 70_000, currentPrice: 69_000 }];

  const decision = await auto.evaluate({ candidates: [], balance: balance(1_000_000, held) });
  assert.equal(auto.status().halted, true, "대사 불일치로 멈춰야 한다");
  assert.equal(decision.action, "ORDER", "멈췄어도 손절은 나가야 한다");
  assert.equal(decision.side, "SELL");
  assert.equal(decision.reason, "STOP_LOSS");
});

test("멈춘 상태에서 신규 진입은 막는다", async () => {
  const service = fakeService({ status: { reconciliation: { status: "MISMATCH" } } });
  const auto = trader({}, service);
  const decision = await auto.evaluate({ candidates: [candidate()], balance: balance() });
  assert.equal(decision.action, "HALTED");
  assert.equal(decision.blocks, "ENTRY");
  assert.equal(service.submitted.length, 0, "멈춘 상태에서 매수는 나가면 안 된다");
});

test("멈춤 때문에 청산이 거부되면 원인을 덮어쓰지 않고 별개로 드러낸다", async () => {
  const service = fakeService({
    status: { reconciliation: { status: "MISMATCH" } },
    throwOnSubmit: true,
  });
  const auto = trader({ stopLossBps: 100, forcedExitTime: null }, service);
  const held = [{ symbol: "005930", quantity: 5, averagePrice: 70_000, currentPrice: 69_000 }];

  const decision = await auto.evaluate({ candidates: [], balance: balance(1_000_000, held) });
  assert.equal(decision.action, "EXIT_BLOCKED");
  assert.equal(decision.haltReason, "RECONCILIATION_MISMATCH", "원래 멈춤 사유가 보존돼야 한다");
  assert.match(decision.detail, /보호 청산이 차단/);
  assert.equal(auto.status().haltReason.code, "RECONCILIATION_MISMATCH");
});

test("멈춘 상태에서도 강제 청산 시각은 동작한다", async () => {
  const service = fakeService({ status: { killSwitch: true } });
  const kst1520 = Date.UTC(2026, 8, 11, 6, 20);
  const auto = new KisPaperAutoTrader({
    orderService: service,
    settings: { enabled: true, forcedExitTime: "15:15" },
    costModel: COST,
    now: () => kst1520,
  });
  const held = [{ symbol: "005930", quantity: 3, averagePrice: 70_000, currentPrice: 70_100 }];
  const decision = await auto.evaluate({ candidates: [], balance: balance(1_000_000, held) });
  assert.equal(decision.reason, "FORCED_EXIT");
  assert.equal(service.submitted.length, 1);
});

// 2026-09-11 사고 재현: 평가가 1ms 차이로 두 번 돌아 042700을 4주씩 두 번 매수했다.
// 저널은 8주, 잔고는 아직 4주여서 대사 불일치가 났다. 대사는 정상 작동했고
// 진짜 버그는 자동매매의 동시성이었다.
test("평가가 겹쳐 호출돼도 주문은 한 번만 나간다", async () => {
  const service = fakeService();
  let tick = BASE;
  const auto = new KisPaperAutoTrader({
    orderService: service,
    settings: { enabled: true, cooldownMs: 0, settlementGraceMs: 0 },
    costModel: COST,
    now: () => (tick += 1), // 1ms씩 흐르는 시계 — 사고 당시와 같은 조건
  });

  const [first, second] = await Promise.all([
    auto.evaluate({ candidates: [candidate()], balance: balance() }),
    auto.evaluate({ candidates: [candidate()], balance: balance() }),
  ]);

  const actions = [first.action, second.action].sort();
  assert.deepEqual(actions, ["ORDER", "SKIP"], `겹친 평가 중 하나는 건너뛰어야 한다: ${actions}`);
  assert.equal(service.submitted.length, 1, "주문은 한 번만 나가야 한다");
});

test("주문 직후 잔고에 안 잡혀도 다시 진입하지 않는다", async () => {
  const service = fakeService();
  let tick = BASE;
  const auto = new KisPaperAutoTrader({
    orderService: service,
    settings: { enabled: true, cooldownMs: 0, settlementGraceMs: 60_000 },
    costModel: COST,
    now: () => tick,
  });

  const first = await auto.evaluate({ candidates: [candidate()], balance: balance() });
  assert.equal(first.action, "ORDER");

  // 29초 뒤 — 사고 당시 간격. 잔고는 아직 비어 있다.
  tick = BASE + 29_000;
  const second = await auto.evaluate({ candidates: [candidate()], balance: balance() });
  assert.equal(second.action, "SKIP");
  assert.equal(second.reason, "AWAITING_SETTLEMENT");
  assert.equal(service.submitted.length, 1, "잔고 미반영 중 재매수가 나가면 안 된다");

  // 잔고에 잡히면 대기가 풀리고 보유 평가로 넘어간다.
  const held = [{ symbol: "005930", quantity: 10, averagePrice: 70_000, currentPrice: 70_050 }];
  tick = BASE + 40_000;
  const third = await auto.evaluate({ candidates: [], balance: balance(1_000_000, held) });
  assert.equal(third.action, "HOLD");
  assert.equal(auto.status().pendingOrder, null);
});

test("잔고 반영이 끝내 안 되면 유예시간 뒤 정상 흐름으로 돌아온다", async () => {
  const service = fakeService();
  let tick = BASE;
  const auto = new KisPaperAutoTrader({
    orderService: service,
    settings: { enabled: true, cooldownMs: 0, settlementGraceMs: 60_000 },
    costModel: COST,
    now: () => tick,
  });
  await auto.evaluate({ candidates: [candidate()], balance: balance() });

  // 주문이 거절됐을 수도 있으므로 영구히 막지 않는다.
  tick = BASE + 61_000;
  const fresh = candidate({
    realtime: { state: "ENTRY_READY", currentPrice: 70_000, spreadBps: 14, latestAt: tick },
  });
  const after = await auto.evaluate({ candidates: [fresh], balance: balance() });
  assert.equal(after.action, "ORDER", "유예시간이 지나면 다시 진입할 수 있어야 한다");
  assert.equal(auto.status().pendingOrder?.symbol, "005930");
});
