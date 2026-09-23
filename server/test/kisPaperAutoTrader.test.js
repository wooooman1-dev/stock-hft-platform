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
      manualKillSwitch: false,
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
    realtime: { state: "ENTRY_READY", latestAt: BASE, metrics: { currentPrice: 70_000, spreadBps: 14 } },
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

test("ENTRY_READY도 WATCH도 아니면 진입하지 않는다", async () => {
  const service = fakeService();
  const auto = trader({}, service);
  const decision = await auto.evaluate({
    candidates: [candidate({ realtime: { state: "STALE", currentPrice: 70_000, latestAt: BASE } })],
    balance: balance(),
  });
  assert.equal(decision.action, "SKIP");
  assert.equal(decision.evaluated[0].reason, "NOT_ENTRY_READY");
  assert.equal(service.submitted.length, 0);
});

// WATCH는 하드 차단(스프레드·거래정지·추격 제한)은 이미 통과했지만 REST 점수
// 75 이상(stage === CONFIRMATION_REQUIRED)과 실시간 호가 불균형·체결강도를
// 전부 동시에 만족하지는 못한 상태다. 한때(2026-09-17) 확신도 점수가 문턱을
// 넘으면 WATCH도 진입을 허용했으나, 2026-09-23 실제 체결 9건을 연구 저널로
// 대조해보니 그중 다수가 반등 근거 12~21bp(노이즈 수준)인 WATCH·LOW_PRIORITY
// 단계에서 들어가 있었다(9건 전부 손실) — ENTRY_READY만 허용하도록 되돌렸다.
test("WATCH는 확신도 점수와 무관하게 진입하지 않는다", async () => {
  const service = fakeService();
  const auto = trader({}, service);
  const decision = await auto.evaluate({
    candidates: [candidate({
      score: 80,
      realtime: {
        state: "WATCH",
        currentPrice: 70_000,
        spreadBps: 14,
        latestAt: BASE,
        metrics: { bookImbalance: 0.05, executionStrength: 100 },
      },
    })],
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
    candidates: [candidate({
      realtime: { state: "ENTRY_READY", latestAt: BASE, metrics: { currentPrice: 70_000, spreadBps: 100 } },
    })],
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
    ["대사 해소됐지만 미확인", { reconciliation: { status: "RESOLVED_AWAITING_ACK" } }],
    ["킬 스위치", { manualKillSwitch: true }],
  ]) {
    const service = fakeService({ status });
    const auto = trader({}, service);
    const decision = await auto.evaluate({ candidates: [candidate()], balance: balance() });
    assert.equal(decision.action, "HALTED", `${label}에서 멈춰야 한다`);
    assert.equal(service.submitted.length, 0);
  }
});

// 2026-09-23: 대사가 PENDING(방금 낸 주문이 아직 KIS에 반영되는 중, 최대 180초 —
// 정상적인 대기 상태)일 때도 예전 코드는 이걸 킬 스위치와 뭉뚱그려서 사람이
// "멈춤 해제"를 눌러야만 풀리는 halt로 확정해버렸다. 거래가 잦아지면서 이 정상
// 대기 순간에 평가 주기가 우연히 걸리는 일이 반복돼 "또 멈췄다"가 반복됐다.
// PENDING·UNAVAILABLE(둘 다 스스로 풀리는 상태)은 이번 주기만 건너뛰고, 사람이
// 개입할 halt로 만들면 안 된다.
test("대사가 PENDING이거나 조회에 실패(UNAVAILABLE)해도 스스로 풀리므로 멈추지 않는다", async () => {
  for (const [label, reconciliationStatus] of [
    ["PENDING", "PENDING"],
    ["UNAVAILABLE", "UNAVAILABLE"],
  ]) {
    const service = fakeService({ status: { reconciliation: { status: reconciliationStatus } } });
    const auto = trader({}, service);
    const decision = await auto.evaluate({ candidates: [candidate()], balance: balance() });
    assert.equal(decision.action, "WAITING", `${label}에서는 멈추지 않고 이번 주기만 건너뛰어야 한다`);
    assert.equal(auto.status().halted, false, `${label}은 사람이 풀어야 하는 halt가 아니다`);
    assert.equal(service.submitted.length, 0);
  }
});

test("PENDING으로 건너뛴 다음 주기에 대사가 CONSISTENT면 사람 개입 없이 바로 진입한다", async () => {
  const service = fakeService({ status: { reconciliation: { status: "PENDING" } } });
  const auto = trader({}, service);
  const skipped = await auto.evaluate({ candidates: [candidate()], balance: balance() });
  assert.equal(skipped.action, "WAITING");

  service.status = () => ({
    killSwitch: false, manualKillSwitch: false, unknownResult: false,
    reconciliation: { status: "CONSISTENT" },
    limits: { maxOrderQuantity: 10, maxOrderValue: 1_000_000 },
  });
  const resumed = await auto.evaluate({ candidates: [candidate()], balance: balance() });
  assert.equal(resumed.action, "ORDER", "멈춤 해제를 누르지 않아도 다시 진입해야 한다");
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
  const service = fakeService({ status: { manualKillSwitch: true } });
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

// 2026-09-23: "좋은 신호가 떠도 이미 다른 종목을 들고 있으면 놓친다"는 문제를
// 진입 품질(ENTRY_READY 문턱)은 그대로 두고 해결하려고 동시 보유 한도를
// 1 → maxConcurrentPositions(기본 5)로 늘렸다.
test("보유 중이어도 자리가 남으면 다른 종목에 새로 진입한다", async () => {
  const service = fakeService();
  const auto = trader({ maxConcurrentPositions: 5 }, service);
  const held = [{ symbol: "005930", quantity: 5, averagePrice: 70_000, currentPrice: 70_050 }];
  const decision = await auto.evaluate({
    candidates: [candidate({ symbol: "000660" })],
    balance: balance(10_000_000, held),
  });
  assert.equal(decision.action, "ORDER");
  assert.equal(decision.side, "BUY");
  assert.equal(decision.symbol, "000660");
});

test("이미 들고 있는 종목은 같은 후보로 다시 매수하지 않는다", async () => {
  const service = fakeService();
  const auto = trader({ maxConcurrentPositions: 5 }, service);
  const held = [{ symbol: "005930", quantity: 5, averagePrice: 70_000, currentPrice: 70_050 }];
  const decision = await auto.evaluate({
    candidates: [candidate({ symbol: "005930" })],
    balance: balance(10_000_000, held),
  });
  assert.equal(decision.action, "HOLD", "보유 중인 종목 자체는 청산 평가만 받는다");
  assert.equal(service.submitted.length, 0);
});

test("동시 보유 한도에 닿으면 신규 진입을 건너뛴다", async () => {
  const service = fakeService();
  const auto = trader({ maxConcurrentPositions: 2 }, service);
  const held = [
    { symbol: "005930", quantity: 5, averagePrice: 70_000, currentPrice: 70_050 },
    { symbol: "000660", quantity: 3, averagePrice: 100_000, currentPrice: 100_050 },
  ];
  const decision = await auto.evaluate({
    candidates: [candidate({ symbol: "035420" })],
    balance: balance(10_000_000, held),
  });
  assert.equal(decision.action, "SKIP");
  assert.equal(decision.reason, "AT_CAPACITY");
  assert.equal(service.submitted.length, 0);
});

test("보유 중인 여러 종목이 동시에 손절 조건에 닿으면 한 주기에 전부 청산한다", async () => {
  const service = fakeService();
  const auto = trader({ maxConcurrentPositions: 5, stopLossBps: 100, forcedExitTime: null }, service);
  const held = [
    { symbol: "005930", quantity: 5, averagePrice: 70_000, currentPrice: 69_000 },
    { symbol: "000660", quantity: 3, averagePrice: 100_000, currentPrice: 98_000 },
  ];
  const decision = await auto.evaluate({ candidates: [], balance: balance(10_000_000, held) });
  // 반환값은 대표로 첫 번째 청산만 담지만, 두 종목 다 이번 주기에 매도가 나가야 한다.
  assert.equal(decision.action, "ORDER");
  assert.equal(decision.side, "SELL");
  assert.equal(service.submitted.length, 2, "두 종목 다 손절이 나가야 한다");
  const symbols = service.submitted.map((order) => order.symbol).sort();
  assert.deepEqual(symbols, ["000660", "005930"]);
});

test("매수 대기 중인 종목도 자리 계산에 들어가 한도를 넘기지 않는다", async () => {
  const service = fakeService();
  const auto = trader({ maxConcurrentPositions: 1, cooldownMs: 0, settlementGraceMs: 60_000 }, service);
  const first = await auto.evaluate({ candidates: [candidate({ symbol: "005930" })], balance: balance() });
  assert.equal(first.action, "ORDER");
  assert.equal(auto.status().pendingOrders.length, 1, "체결이 잔고에 아직 안 잡혀도 대기 목록에 있어야 한다");

  // 잔고는 아직 비어 있지만(대사 반영 전) 대기 중인 종목이 이미 한도(1)를 채웠다.
  const second = await auto.evaluate({
    candidates: [candidate({ symbol: "000660" })],
    balance: balance(),
  });
  assert.equal(second.action, "SKIP");
  assert.equal(second.reason, "AT_CAPACITY");
  assert.equal(service.submitted.length, 1);
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

  // 29초 뒤 — 사고 당시 간격. 잔고는 아직 비어 있다. 같은 종목은 대기 중이라 걸러진다.
  tick = BASE + 29_000;
  const second = await auto.evaluate({ candidates: [candidate()], balance: balance() });
  assert.equal(second.action, "SKIP");
  assert.equal(second.reason, "NO_ELIGIBLE_CANDIDATE");
  assert.equal(second.evaluated[0].reason, "ALREADY_HELD_OR_PENDING");
  assert.equal(service.submitted.length, 1, "잔고 미반영 중 재매수가 나가면 안 된다");

  // 잔고에 잡히면 대기가 풀리고 보유 평가로 넘어간다.
  const held = [{ symbol: "005930", quantity: 10, averagePrice: 70_000, currentPrice: 70_050 }];
  tick = BASE + 40_000;
  const third = await auto.evaluate({ candidates: [], balance: balance(1_000_000, held) });
  assert.equal(third.action, "HOLD");
  assert.deepEqual(auto.status().pendingOrders, []);
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
  assert.equal(auto.status().pendingOrders[0]?.symbol, "005930");
});
