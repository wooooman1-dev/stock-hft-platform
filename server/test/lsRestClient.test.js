import assert from "node:assert/strict";
import test from "node:test";
import { LsRestClient } from "../brokers/ls/lsRestClient.js";

test("LS t1101 current order book request is built and normalized", async () => {
  const requests = [];
  const out = { price: "72100", jnilclose: "70000" };
  for (let level = 1; level <= 10; level += 1) {
    out[`offerho${level}`] = String(72_100 + level * 100);
    out[`offerrem${level}`] = String(level * 10);
    out[`bidho${level}`] = String(72_100 - level * 100);
    out[`bidrem${level}`] = String(level * 20);
  }
  const client = new LsRestClient({
    authClient: { getAccessToken: async () => "access-token" },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ rsp_cd: "00000", rsp_msg: "정상", t1101OutBlock: out }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const snapshot = await client.getCurrentOrderBook("005930");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://openapi.ls-sec.co.kr:8080/stock/market-data");
  assert.equal(requests[0].options.headers.authorization, "Bearer access-token");
  assert.equal(requests[0].options.headers.tr_cd, "t1101");
  assert.deepEqual(JSON.parse(requests[0].options.body), { t1101InBlock: { shcode: "005930" } });
  assert.equal(snapshot.lastPrice, 72_100);
  assert.equal(snapshot.previousClose, 70_000);
  assert.deepEqual(snapshot.book.asks[0], { price: 72_200, size: 10 });
  assert.deepEqual(snapshot.book.bids[0], { price: 72_000, size: 20 });
});

test("LS REST client surfaces HTTP response details", async () => {
  const client = new LsRestClient({
    authClient: { getAccessToken: async () => "access-token" },
    fetchImpl: async () => new Response(JSON.stringify({ rsp_msg: "인증 실패" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
  });
  await assert.rejects(() => client.getCurrentOrderBook("005930"), /인증 실패/);
});
