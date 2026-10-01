import test from "node:test";
import assert from "node:assert/strict";
import { PaperOrderError, PaperTrader, loadPaperCostModel } from "../domain/paperTrader.js";

const book = ({ asks = [], bids = [] } = {}) => ({ asks, bids });
const base = {
  tickSize: 100,
  referencePrice: 70_000,
  source: "MANUAL",
  killSwitch: false,
  timestamp: 1_000,
};

test("market order consumes visible depth and calculates volume-weighted fill price", () => {
  const trader = new PaperTrader(10_000_000, { now: () => 1_000 });
  const order = trader.submit({
    ...base,
    side: "BUY",
    type: "MARKET",
    quantity: 10,
    clientOrderId: "market-buy-1",
    book: book({ asks: [{ price: 70_000, size: 5 }, { price: 70_100, size: 10 }] }),
  });

  assert.equal(order.status, "FILLED");
  assert.equal(order.isOpen, false);
  assert.equal(order.filledQuantity, 10);
  assert.equal(order.remainingQuantity, 0);
  assert.equal(order.averageFilledPrice, 70_050);
  assert.deepEqual(order.fills.map((fill) => [fill.price, fill.quantity]), [[70_000, 5], [70_100, 5]]);
  const account = trader.snapshot(70_100);
  assert.equal(account.cash, 9_299_500);
  assert.equal(account.position.quantity, 10);
  assert.equal(account.position.averagePrice, 70_050);
});


test("market sell reduces position and calculates realized pnl from actual bid depth", () => {
  const trader = new PaperTrader();
  trader.submit({
    ...base,
    side: "BUY",
    type: "MARKET",
    quantity: 10,
    clientOrderId: "roundtrip-buy",
    book: book({ asks: [{ price: 70_000, size: 10 }] }),
  });
  const sell = trader.submit({
    ...base,
    timestamp: 2_000,
    referencePrice: 71_000,
    side: "SELL",
    type: "MARKET",
    quantity: 4,
    clientOrderId: "roundtrip-sell",
    book: book({ bids: [{ price: 71_000, size: 4 }] }),
  });

  assert.equal(sell.status, "FILLED");
  assert.equal(sell.averageFilledPrice, 71_000);
  const account = trader.snapshot(71_000);
  assert.equal(account.position.quantity, 6);
  assert.equal(account.position.averagePrice, 70_000);
  assert.equal(account.realizedPnl, 4_000);
  assert.equal(account.unrealizedPnl, 6_000);
});

test("multiple open orders share one working book in FIFO order", () => {
  const trader = new PaperTrader();
  const restingBook = book({ asks: [{ price: 70_000, size: 10 }], bids: [{ price: 69_800, size: 10 }] });
  const first = trader.submit({
    ...base,
    side: "BUY",
    type: "LIMIT",
    quantity: 2,
    limitPrice: 69_900,
    clientOrderId: "fifo-1",
    book: restingBook,
  });
  const second = trader.submit({
    ...base,
    timestamp: 1_001,
    side: "BUY",
    type: "LIMIT",
    quantity: 2,
    limitPrice: 69_900,
    clientOrderId: "fifo-2",
    book: restingBook,
  });
  assert.equal(first.status, "ACCEPTED");
  assert.equal(second.status, "ACCEPTED");

  trader.processOpenOrders({
    timestamp: 2_000,
    book: book({ asks: [{ price: 69_900, size: 3 }], bids: [{ price: 69_800, size: 10 }] }),
  });
  const orders = Object.fromEntries(trader.snapshot(69_900).orders.map((order) => [order.clientOrderId, order]));
  assert.equal(orders["fifo-1"].status, "FILLED");
  assert.equal(orders["fifo-1"].filledQuantity, 2);
  assert.equal(orders["fifo-2"].status, "PARTIALLY_FILLED");
  assert.equal(orders["fifo-2"].filledQuantity, 1);
  assert.equal(orders["fifo-2"].remainingQuantity, 1);
});

test("market order cancels an unfilled IOC remainder instead of inventing hidden liquidity", () => {
  const trader = new PaperTrader();
  const order = trader.submit({
    ...base,
    side: "BUY",
    type: "MARKET",
    quantity: 5,
    clientOrderId: "market-partial-1",
    book: book({ asks: [{ price: 70_000, size: 3 }] }),
  });

  assert.equal(order.status, "PARTIALLY_FILLED");
  assert.equal(order.isOpen, false);
  assert.equal(order.filledQuantity, 3);
  assert.equal(order.cancelledQuantity, 2);
  assert.equal(order.remainingQuantity, 0);
  assert.match(order.reason, /IOC/);
});

test("non-crossing limit order stays open, reserves cash, and fills on a later crossing book", () => {
  const trader = new PaperTrader();
  const order = trader.submit({
    ...base,
    side: "BUY",
    type: "LIMIT",
    quantity: 10,
    limitPrice: 69_900,
    clientOrderId: "limit-buy-1",
    book: book({ asks: [{ price: 70_000, size: 20 }], bids: [{ price: 69_900, size: 20 }] }),
  });

  assert.equal(order.status, "ACCEPTED");
  assert.equal(order.isOpen, true);
  assert.equal(trader.snapshot(70_000).reservedCash, 699_000);

  trader.processOpenOrders({
    timestamp: 2_000,
    book: book({ asks: [{ price: 69_900, size: 4 }], bids: [{ price: 69_800, size: 20 }] }),
  });
  let updated = trader.snapshot(69_900).orders[0];
  assert.equal(updated.status, "PARTIALLY_FILLED");
  assert.equal(updated.isOpen, true);
  assert.equal(updated.filledQuantity, 4);
  assert.equal(updated.remainingQuantity, 6);
  assert.equal(trader.snapshot(69_900).reservedCash, 419_400);

  trader.processOpenOrders({
    timestamp: 3_000,
    book: book({ asks: [{ price: 69_800, size: 6 }], bids: [{ price: 69_700, size: 20 }] }),
  });
  updated = trader.snapshot(69_800).orders[0];
  assert.equal(updated.status, "FILLED");
  assert.equal(updated.isOpen, false);
  assert.equal(updated.filledQuantity, 10);
  assert.equal(updated.averageFilledPrice, 69_840);
});

test("open limit order can be cancelled and releases its reservation", () => {
  const trader = new PaperTrader();
  const order = trader.submit({
    ...base,
    side: "BUY",
    type: "LIMIT",
    quantity: 10,
    limitPrice: 69_900,
    clientOrderId: "cancel-limit-1",
    book: book({ asks: [{ price: 70_000, size: 20 }] }),
  });

  const cancelled = trader.cancel(order.id, { timestamp: 2_000 });
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(cancelled.isOpen, false);
  assert.equal(cancelled.cancelledQuantity, 10);
  assert.equal(trader.snapshot(70_000).reservedCash, 0);

  const replay = trader.cancel(order.id, { timestamp: 3_000 });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.status, "CANCELLED");
});

test("same clientOrderId and payload is idempotent", () => {
  const trader = new PaperTrader();
  const request = {
    ...base,
    side: "BUY",
    type: "MARKET",
    quantity: 2,
    clientOrderId: "same-request-1",
    book: book({ asks: [{ price: 70_000, size: 10 }] }),
  };
  const first = trader.submit(request);
  const second = trader.submit(request);

  assert.equal(second.id, first.id);
  assert.equal(second.idempotentReplay, true);
  assert.equal(trader.snapshot(70_000).position.quantity, 2);
  assert.equal(trader.snapshot(70_000).orders.length, 1);
});

test("same clientOrderId with different payload is rejected as a conflict", () => {
  const trader = new PaperTrader();
  trader.submit({
    ...base,
    side: "BUY",
    type: "LIMIT",
    quantity: 2,
    limitPrice: 69_900,
    clientOrderId: "conflict-1",
    book: book({ asks: [{ price: 70_000, size: 10 }] }),
  });

  assert.throws(() => trader.submit({
    ...base,
    side: "BUY",
    type: "LIMIT",
    quantity: 3,
    limitPrice: 69_900,
    clientOrderId: "conflict-1",
    book: book({ asks: [{ price: 70_000, size: 10 }] }),
  }), (error) => error instanceof PaperOrderError && error.statusCode === 409);
});

test("open sell orders reserve shares and prevent overselling", () => {
  const trader = new PaperTrader();
  trader.submit({
    ...base,
    side: "BUY",
    type: "MARKET",
    quantity: 10,
    clientOrderId: "seed-position",
    book: book({ asks: [{ price: 70_000, size: 10 }] }),
  });
  const openSell = trader.submit({
    ...base,
    timestamp: 2_000,
    side: "SELL",
    type: "LIMIT",
    quantity: 8,
    limitPrice: 71_000,
    clientOrderId: "open-sell-1",
    book: book({ bids: [{ price: 70_000, size: 20 }] }),
  });
  assert.equal(openSell.status, "ACCEPTED");
  assert.equal(trader.snapshot(70_000).sellableQuantity, 2);

  const rejected = trader.submit({
    ...base,
    timestamp: 3_000,
    side: "SELL",
    type: "MARKET",
    quantity: 3,
    clientOrderId: "oversell-1",
    book: book({ bids: [{ price: 70_000, size: 20 }] }),
  });
  assert.equal(rejected.status, "REJECTED");
  assert.match(rejected.reason, /매도 가능 수량/);
});

test("open buy orders reserve cash for subsequent orders", () => {
  const trader = new PaperTrader(1_000_000);
  const first = trader.submit({
    ...base,
    side: "BUY",
    type: "LIMIT",
    quantity: 10,
    limitPrice: 70_000,
    clientOrderId: "reserve-cash-1",
    book: book({ asks: [{ price: 70_100, size: 20 }] }),
  });
  assert.equal(first.status, "ACCEPTED");
  assert.equal(trader.snapshot(70_000).availableCash, 300_000);

  const second = trader.submit({
    ...base,
    timestamp: 2_000,
    side: "BUY",
    type: "LIMIT",
    quantity: 5,
    limitPrice: 70_000,
    clientOrderId: "reserve-cash-2",
    book: book({ asks: [{ price: 70_100, size: 20 }] }),
  });
  assert.equal(second.status, "REJECTED");
  assert.match(second.reason, /가용 현금/);
});


test("invalid order schema fails with a 400 error before creating an order", () => {
  const trader = new PaperTrader();
  assert.throws(() => trader.submit({
    ...base,
    side: "BUY",
    type: "LIMIT",
    quantity: 0,
    limitPrice: 69_950,
    clientOrderId: "invalid-schema",
    book: book({ asks: [{ price: 70_000, size: 10 }] }),
  }), (error) => error instanceof PaperOrderError && error.statusCode === 400);
  assert.equal(trader.snapshot(70_000).orders.length, 0);
});

test("kill switch rejects new orders before acceptance", () => {
  const trader = new PaperTrader();
  const order = trader.submit({
    ...base,
    side: "BUY",
    type: "MARKET",
    quantity: 1,
    clientOrderId: "kill-1",
    killSwitch: true,
    book: book({ asks: [{ price: 70_000, size: 10 }] }),
  });
  assert.equal(order.status, "REJECTED");
  assert.equal(order.remainingQuantity, 0);
  assert.equal(order.rejectedQuantity, 1);
  assert.match(order.reason, /킬 스위치/);
});

test("orders omitted from the 100-row snapshot still keep risk reservations", () => {
  const trader = new PaperTrader();
  for (let index = 0; index < 101; index += 1) {
    const order = trader.submit({
      ...base,
      timestamp: 10_000 + index,
      side: "BUY",
      type: "LIMIT",
      quantity: 1,
      limitPrice: 100,
      clientOrderId: `many-open-${index}`,
      book: book({ asks: [{ price: 70_000, size: 10 }] }),
    });
    assert.equal(order.status, "ACCEPTED");
  }
  const account = trader.snapshot(70_000);
  assert.equal(account.orders.length, 100);
  assert.equal(account.openOrderCount, 101);
  assert.equal(account.reservedCash, 10_100);
});

test("omitted timestamp uses the injected clock for order and fill events", () => {
  const trader = new PaperTrader(10_000_000, { now: () => 55_000 });
  const order = trader.submit({
    tickSize: 100,
    referencePrice: 70_000,
    source: "MANUAL",
    killSwitch: false,
    side: "BUY",
    type: "MARKET",
    quantity: 1,
    clientOrderId: "clock-test",
    book: book({ asks: [{ price: 70_000, size: 1 }] }),
  });
  assert.equal(order.createdAt, 55_000);
  assert.equal(order.fills[0].timestamp, 55_000);
  assert.ok(order.events.every((event) => event.timestamp === 55_000));
});

test("PaperTrader defaults to a zero-cost model when none is provided", () => {
  const trader = new PaperTrader();
  assert.deepEqual(trader.costModel, {
    buyCommissionBps: 0,
    sellCommissionBps: 0,
    sellTaxBps: 0,
    slippageTicks: 0,
  });
});

test("buy commission is charged on top of fill value and folded into the cost basis", () => {
  const trader = new PaperTrader(10_000_000, { now: () => 1_000, costModel: { buyCommissionBps: 100 } });
  const order = trader.submit({
    ...base,
    side: "BUY",
    type: "MARKET",
    quantity: 10,
    clientOrderId: "fee-buy-1",
    book: book({ asks: [{ price: 70_000, size: 10 }] }),
  });
  assert.equal(order.fills[0].fee, 7_000);
  assert.equal(order.fills[0].tax, 0);
  const account = trader.snapshot(70_000);
  assert.equal(account.cash, 10_000_000 - 700_000 - 7_000);
  assert.equal(account.position.averagePrice, 70_700);
  assert.equal(account.totalFeesPaid, 7_000);
  assert.equal(account.totalTaxPaid, 0);
});

test("sell commission and tax reduce proceeds and realized pnl", () => {
  const trader = new PaperTrader(10_000_000, {
    now: () => 1_000,
    costModel: { sellCommissionBps: 50, sellTaxBps: 20 },
  });
  trader.submit({
    ...base,
    side: "BUY",
    type: "MARKET",
    quantity: 10,
    clientOrderId: "fee-sell-buy",
    book: book({ asks: [{ price: 70_000, size: 10 }] }),
  });
  const sell = trader.submit({
    ...base,
    timestamp: 2_000,
    referencePrice: 71_000,
    side: "SELL",
    type: "MARKET",
    quantity: 4,
    clientOrderId: "fee-sell-1",
    book: book({ bids: [{ price: 71_000, size: 4 }] }),
  });
  assert.equal(sell.fills[0].fee, 1_420);
  assert.equal(sell.fills[0].tax, 568);
  const account = trader.snapshot(71_000);
  assert.equal(account.cash, 10_000_000 - 700_000 + (284_000 - 1_420 - 568));
  assert.equal(account.realizedPnl, (71_000 - 70_000) * 4 - 1_420 - 568);
  assert.equal(account.totalFeesPaid, 1_420);
  assert.equal(account.totalTaxPaid, 568);
});

test("slippage moves the executed price against the trader for market orders only", () => {
  const trader = new PaperTrader(10_000_000, { now: () => 1_000, costModel: { slippageTicks: 2 } });
  const marketBuy = trader.submit({
    ...base,
    side: "BUY",
    type: "MARKET",
    quantity: 5,
    clientOrderId: "slippage-market-buy",
    book: book({ asks: [{ price: 70_000, size: 5 }] }),
  });
  assert.equal(marketBuy.fills[0].bookPrice, 70_000);
  assert.equal(marketBuy.fills[0].price, 70_200);
  assert.equal(marketBuy.averageFilledPrice, 70_200);

  const limitBuy = trader.submit({
    ...base,
    timestamp: 2_000,
    side: "BUY",
    type: "LIMIT",
    quantity: 5,
    limitPrice: 70_000,
    clientOrderId: "slippage-limit-buy",
    book: book({ asks: [{ price: 70_000, size: 5 }] }),
  });
  assert.equal(limitBuy.fills[0].bookPrice, 70_000);
  assert.equal(limitBuy.fills[0].price, 70_000);
});

test("loadPaperCostModel falls back to reference defaults and honors env overrides", () => {
  assert.deepEqual(loadPaperCostModel({}), {
    buyCommissionBps: 1.40527,
    sellCommissionBps: 1.40527,
    sellTaxBps: 20,
    slippageTicks: 1,
  });
  assert.deepEqual(loadPaperCostModel({
    PULSEHFT_PAPER_BUY_COMMISSION_BPS: "5",
    PULSEHFT_PAPER_SELL_COMMISSION_BPS: "5",
    PULSEHFT_PAPER_SELL_TAX_BPS: "10",
    PULSEHFT_PAPER_SLIPPAGE_TICKS: "0",
  }), {
    buyCommissionBps: 5,
    sellCommissionBps: 5,
    sellTaxBps: 10,
    slippageTicks: 0,
  });
});

test("an invalid cost model is rejected at construction time", () => {
  assert.throws(() => new PaperTrader(10_000_000, { costModel: { buyCommissionBps: -1 } }), TypeError);
  assert.throws(() => new PaperTrader(10_000_000, { costModel: { slippageTicks: 1.5 } }), TypeError);
});
