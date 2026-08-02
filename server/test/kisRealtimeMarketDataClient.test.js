import test from "node:test";
import assert from "node:assert/strict";
import {
  KisRealtimeMarketDataClient,
  KIS_REALTIME_TR,
} from "../integrations/kis/kisRealtimeMarketDataClient.js";

const config = {
  enabled: true,
  mode: "PROD_READ_ONLY",
  baseUrl: "https://openapi.koreainvestment.com:9443",
  appKey: "APP-SECRET-KEY",
  appSecret: "APP-SECRET-VALUE",
};

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  addEventListener(event, listener) {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  emit(event, value = {}) {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  send(value) { this.sent.push(value); }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

test("KIS 승인키를 발급하고 KRX 호가·체결을 함께 구독한다", async () => {
  FakeWebSocket.instances = [];
  const requests = [];
  const client = new KisRealtimeMarketDataClient({
    config,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return response({ approval_key: "APPROVAL-TOKEN" });
    },
    WebSocketImpl: FakeWebSocket,
    timeoutMs: 1_000,
  });

  client.watchSymbols([{ symbol: "005930", venue: "KRX" }]);
  await flush();
  const socket = FakeWebSocket.instances[0];
  assert.ok(socket);
  socket.open();
  await flush();

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/oauth2\/Approval$/);
  const approvalBody = JSON.parse(requests[0].options.body);
  assert.equal(approvalBody.appkey, config.appKey);
  assert.equal(approvalBody.secretkey, config.appSecret);
  const subscriptions = socket.sent.map((item) => JSON.parse(item));
  assert.deepEqual(subscriptions.map((item) => item.body.input.tr_id).sort(), [
    KIS_REALTIME_TR.KRX.orderBook,
    KIS_REALTIME_TR.KRX.trade,
  ].sort());
  assert.ok(subscriptions.every((item) => item.header.tr_type === "1"));
  assert.equal(client.status().connected, true);
  client.stop();
});

test("실시간 호가·체결 레코드를 정규화하고 비밀정보를 상태에서 제외한다", async () => {
  let now = 1_000_000;
  const client = new KisRealtimeMarketDataClient({
    config,
    fetchImpl: async () => response({ approval_key: "APPROVAL-TOKEN" }),
    WebSocketImpl: FakeWebSocket,
    now: () => now,
  });
  client.socket = { readyState: 1, send() {} };
  client.state = "CONNECTED";

  await client.handleMessage(`0|H0STASP0|1|${orderBookValues().join("^")}`);
  now += 20;
  await client.handleMessage(`0|H0STCNT0|1|${tradeValues().join("^")}`);
  const snapshot = client.snapshot("005930");

  assert.equal(snapshot.orderBook.bestAsk, 70_100);
  assert.equal(snapshot.orderBook.bestBid, 70_000);
  assert.equal(snapshot.orderBook.totalAskSize, 10_000);
  assert.equal(snapshot.orderBook.totalBidSize, 15_000);
  assert.equal(snapshot.trade.currentPrice, 70_050);
  assert.equal(snapshot.trade.executionStrength, 125.5);
  assert.equal(snapshot.trade.viStandardPrice, 71_000);
  assert.equal(snapshot.stale, false);

  const publicText = JSON.stringify(client.status());
  assert.doesNotMatch(publicText, /APP-SECRET-KEY/);
  assert.doesNotMatch(publicText, /APP-SECRET-VALUE/);
  assert.doesNotMatch(publicText, /APPROVAL-TOKEN/);
});

test("NXT 확장 호가 필드와 통합 TR 스키마를 정확히 해석한다", async () => {
  const client = new KisRealtimeMarketDataClient({
    config,
    fetchImpl: async () => response({ approval_key: "APPROVAL-TOKEN" }),
    WebSocketImpl: FakeWebSocket,
    now: () => 2_000_000,
  });
  client.socket = { readyState: 1, send() {} };
  client.state = "CONNECTED";

  const values = [...orderBookValues(), "70050", "9000", "K", "70040", "11000", "N"];
  await client.handleMessage(`0|H0NXASP0|1|${values.join("^")}`);
  const snapshot = client.snapshot("005930");

  assert.equal(snapshot.venue, "NXT");
  assert.equal(snapshot.orderBook.trId, KIS_REALTIME_TR.NXT.orderBook);
  assert.equal(snapshot.orderBook.krxMidPrice, 70_050);
  assert.equal(snapshot.orderBook.krxMidTotalSize, 9_000);
  assert.equal(snapshot.orderBook.nxtMidPrice, 70_040);
  assert.equal(snapshot.orderBook.nxtMidTotalSize, 11_000);
});

test("PINGPONG 메시지는 원문 그대로 회신한다", async () => {
  const sent = [];
  const client = new KisRealtimeMarketDataClient({
    config,
    fetchImpl: async () => response({ approval_key: "APPROVAL-TOKEN" }),
    WebSocketImpl: FakeWebSocket,
  });
  client.socket = { readyState: 1, send(value) { sent.push(value); } };
  client.state = "CONNECTED";
  const ping = JSON.stringify({ header: { tr_id: "PINGPONG" } });
  await client.handleMessage(ping);
  assert.deepEqual(sent, [ping]);
});

function orderBookValues() {
  const values = Array(59).fill("");
  values[0] = "005930";
  values[1] = "101500";
  values[2] = "0";
  for (let index = 0; index < 10; index += 1) {
    values[3 + index] = String(70_100 + index * 100);
    values[13 + index] = String(70_000 - index * 100);
    values[23 + index] = String(1_000 + index);
    values[33 + index] = String(1_500 + index);
  }
  values[43] = "10000";
  values[44] = "15000";
  values[56] = "10";
  values[57] = "20";
  values[58] = "0";
  return values;
}

function tradeValues() {
  const values = Array(46).fill("");
  values[0] = "005930";
  values[1] = "101501";
  values[2] = "70050";
  values[3] = "2";
  values[4] = "1050";
  values[5] = "1.52";
  values[6] = "69950";
  values[7] = "69000";
  values[8] = "70500";
  values[9] = "68800";
  values[10] = "70100";
  values[11] = "70000";
  values[12] = "123";
  values[13] = "1234567";
  values[14] = "86400000000";
  values[18] = "125.5";
  values[35] = "N";
  values[38] = "10000";
  values[39] = "15000";
  values[45] = "71000";
  return values;
}

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return payload; } };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}
