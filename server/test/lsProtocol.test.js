import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRealtimeSubscription,
  getRealtimeTrCodes,
  normalizeRealtimeBook,
  normalizeRealtimeTrade,
} from "../brokers/ls/lsProtocol.js";

test("LS realtime TR codes are selected by market", () => {
  assert.deepEqual(getRealtimeTrCodes("KOSPI"), { book: "H1_", trade: "S3_" });
  assert.deepEqual(getRealtimeTrCodes("KOSDAQ"), { book: "HA_", trade: "K3_" });
  assert.deepEqual(getRealtimeTrCodes("UNIFIED"), { book: "UH1", trade: "US3" });
});

test("LS realtime subscription follows the official token/tr_type/body shape", () => {
  assert.deepEqual(buildRealtimeSubscription({ token: "token", trCode: "H1_", symbol: "005930" }), {
    header: { token: "token", tr_type: "3" },
    body: { tr_cd: "H1_", tr_key: "005930" },
  });
});

test("LS order book payload is normalized into best-first bid and ask levels", () => {
  const body = {};
  for (let level = 1; level <= 10; level += 1) {
    body[`offerho${level}`] = String(72_100 + level * 100);
    body[`offerrem${level}`] = String(level * 10);
    body[`bidho${level}`] = String(72_100 - level * 100);
    body[`bidrem${level}`] = String(level * 20);
  }
  const book = normalizeRealtimeBook({ header: { tr_cd: "H1_", tr_key: "005930" }, body });
  assert.equal(book.symbol, "005930");
  assert.deepEqual(book.asks[0], { price: 72_200, size: 10 });
  assert.deepEqual(book.bids[0], { price: 72_000, size: 20 });
  assert.equal(book.asks.length, 10);
  assert.equal(book.bids.length, 10);
});

test("LS trade payload is normalized with aggressor side", () => {
  const trade = normalizeRealtimeTrade({
    header: { tr_cd: "S3_", tr_key: "005930" },
    body: { shcode: "005930", price: "72100", cvolume: "15", cgubun: "+", chetime: "093001" },
  }, 1_234_567);
  assert.deepEqual(trade, {
    symbol: "005930",
    timestamp: 1_234_567,
    price: 72_100,
    size: 15,
    side: "BUY",
    exchangeTime: "093001",
  });
});
