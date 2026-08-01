import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  InstrumentSwitchError,
  MarketRuntime,
} from "../domain/runtime.js";
import {
  SelectedInstrumentError,
  SelectedInstrumentStore,
} from "../domain/selectedInstrumentStore.js";
import { MarketSimulator } from "../domain/simulator.js";

const hynix = {
  symbol: "000660",
  symbolName: "SK하이닉스",
  market: "KOSPI",
  securityType: "주식",
  initialPrice: 1_718_000,
  previousClose: 1_322_000,
  tickSize: 1_000,
  priceSource: "KIS_PROD_READ_ONLY",
  quoteFetchedAt: 1_785_585_785_620,
};

function createRuntime() {
  let now = 1_785_585_785_620;
  return new MarketRuntime("005930", "삼성전자", 70_000, {
    now: () => now++,
  });
}

test("selected instrument store persists and restores the validated selection", () => {
  const directory = mkdtempSync(join(tmpdir(), "pulsehft-selected-instrument-"));
  const path = join(directory, "selected-instrument.json");
  try {
    const store = new SelectedInstrumentStore(path, { now: () => 1234 });
    const saved = store.save(hynix);
    assert.equal(saved.selectedAt, 1234);
    assert.deepEqual(store.load(), saved);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("selected instrument store rejects corrupt state instead of silently replacing it", () => {
  const directory = mkdtempSync(join(tmpdir(), "pulsehft-selected-instrument-corrupt-"));
  const path = join(directory, "selected-instrument.json");
  try {
    writeFileSync(path, "{broken", "utf8");
    const store = new SelectedInstrumentStore(path);
    assert.throws(() => store.load(), (error) => (
      error instanceof SelectedInstrumentError
      && error.code === "SELECTED_INSTRUMENT_CORRUPT"
    ));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("market simulator uses the selected instrument quote tick size", () => {
  const simulator = new MarketSimulator(1_718_000, { tickSize: 1_000 });
  const tick = simulator.next(1_000);
  assert.equal(simulator.tickSize, 1_000);
  assert.equal(tick.lastPrice % 1_000, 0);
  assert.ok(tick.book.asks.every((level) => level.price % 1_000 === 0));
  assert.ok(tick.book.bids.every((level) => level.price % 1_000 === 0));
});

test("runtime switches the main symbol and rebuilds simulation from the KIS quote", () => {
  const runtime = createRuntime();
  let persisted = null;
  const result = runtime.switchInstrument(hynix, {
    persist: (selection) => { persisted = selection; },
  });
  assert.equal(result.changed, true);
  assert.equal(result.snapshot.symbol, "000660");
  assert.equal(result.snapshot.symbolName, "SK하이닉스");
  assert.equal(result.snapshot.previousClose, 1_322_000);
  assert.equal(result.snapshot.tickSize, 1_000);
  assert.equal(result.snapshot.instrument.market, "KOSPI");
  assert.equal(result.snapshot.instrument.priceSource, "KIS_PROD_READ_ONLY");
  assert.equal(result.snapshot.account.orders.length, 0);
  assert.equal(persisted.symbol, "000660");
  assert.ok(Number.isFinite(persisted.selectedAt));
});

test("runtime blocks an instrument switch while a position is open", () => {
  const runtime = createRuntime();
  runtime.submitOrder({
    side: "BUY",
    type: "MARKET",
    quantity: 1,
    clientOrderId: "position-before-switch",
  });
  assert.throws(() => runtime.switchInstrument(hynix), (error) => (
    error instanceof InstrumentSwitchError
    && error.code === "INSTRUMENT_SWITCH_POSITION_OPEN"
  ));
  assert.equal(runtime.snapshot().symbol, "005930");
});

test("runtime blocks an instrument switch while a limit order is open", () => {
  const runtime = createRuntime();
  const snapshot = runtime.snapshot();
  runtime.submitOrder({
    side: "BUY",
    type: "LIMIT",
    quantity: 1,
    limitPrice: snapshot.lastPrice - snapshot.tickSize * 20,
    clientOrderId: "open-order-before-switch",
  });
  assert.equal(runtime.snapshot().account.openOrderCount, 1);
  assert.throws(() => runtime.switchInstrument(hynix), (error) => (
    error instanceof InstrumentSwitchError
    && error.code === "INSTRUMENT_SWITCH_ORDER_OPEN"
  ));
});

test("runtime blocks mixed order history until the internal paper account is reset", () => {
  const runtime = createRuntime();
  runtime.submitOrder({
    side: "SELL",
    type: "MARKET",
    quantity: 1,
    clientOrderId: "rejected-history-before-switch",
  });
  const account = runtime.snapshot().account;
  assert.equal(account.position.quantity, 0);
  assert.equal(account.openOrderCount, 0);
  assert.equal(account.orders.length, 1);
  assert.throws(() => runtime.switchInstrument(hynix), (error) => (
    error instanceof InstrumentSwitchError
    && error.code === "INSTRUMENT_SWITCH_ACCOUNT_NOT_RESET"
  ));
});

test("selecting the already active symbol is idempotent and does not reset state", () => {
  const runtime = createRuntime();
  runtime.submitOrder({
    side: "SELL",
    type: "MARKET",
    quantity: 1,
    clientOrderId: "same-symbol-history",
  });
  const before = runtime.snapshot();
  const result = runtime.switchInstrument({
    symbol: "005930",
    symbolName: "삼성전자",
    initialPrice: before.lastPrice,
    previousClose: before.previousClose,
    tickSize: before.tickSize,
    priceSource: "KIS_PROD_READ_ONLY",
  });
  assert.equal(result.changed, false);
  assert.equal(result.snapshot.account.orders.length, 1);
  assert.equal(result.snapshot.symbol, "005930");
});
