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

// 2026-08-04 사고 회귀 방지: KIS는 핸드셰이크를 통과시킨 뒤 구독 응답에서 거절한다.
// open 시점에 백오프를 리셋하면 거절 루프가 최소 지연으로 무한 반복된다(225분 13,057회).
test("소켓 open만으로는 백오프를 리셋하지 않고 구독 성공에서만 리셋한다", async () => {
  FakeWebSocket.instances = [];
  const client = new KisRealtimeMarketDataClient({
    config,
    fetchImpl: async () => response({ approval_key: "APPROVAL-TOKEN" }),
    WebSocketImpl: FakeWebSocket,
    setTimeoutImpl: () => null,
    clearTimeoutImpl: () => {},
  });
  client.watchSymbols([{ symbol: "005930", venue: "KRX" }]);
  await flush();
  client.reconnectAttempt = 4;

  FakeWebSocket.instances[0].open();
  await flush();
  assert.equal(client.reconnectAttempt, 4, "open만으로 리셋되면 안 된다");
  assert.equal(client.status().subscriptionEstablished, false);

  await client.handleMessage(JSON.stringify({
    header: { tr_id: "H0STASP0" },
    body: { rt_cd: "0", msg1: "SUBSCRIBE SUCCESS" },
  }));
  assert.equal(client.reconnectAttempt, 0, "구독 성공에서 리셋되어야 한다");
  assert.equal(client.status().subscriptionEstablished, true);
  client.stop();
});

test("백오프가 재시도마다 지수적으로 늘고 상한에서 멈춘다", async () => {
  const delays = [];
  const client = new KisRealtimeMarketDataClient({
    config,
    fetchImpl: async () => response({ approval_key: "APPROVAL-TOKEN" }),
    WebSocketImpl: FakeWebSocket,
    reconnectBaseMs: 1_000,
    reconnectMaxMs: 30_000,
    setTimeoutImpl: (fn, delay) => { delays.push(delay); return delays.length; },
    clearTimeoutImpl: () => {},
  });
  client.started = true;
  client.desired = new Map([["005930", { symbol: "005930", venue: "KRX" }]]);
  for (let i = 0; i < 8; i += 1) {
    client.reconnectTimer = null;
    client.scheduleReconnect();
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  client.stop();
});

test("ALREADY IN USE appkey는 재연결을 멈추고 BLOCKED 상태로 원인을 노출한다", async () => {
  FakeWebSocket.instances = [];
  const scheduled = [];
  const client = new KisRealtimeMarketDataClient({
    config,
    fetchImpl: async () => response({ approval_key: "APPROVAL-TOKEN" }),
    WebSocketImpl: FakeWebSocket,
    setTimeoutImpl: (fn, delay) => { scheduled.push(delay); return scheduled.length; },
    clearTimeoutImpl: () => {},
  });
  client.watchSymbols([{ symbol: "005930", venue: "KRX" }]);
  await flush();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await flush();
  scheduled.length = 0;

  await client.handleMessage(JSON.stringify({
    header: { tr_id: "H0STASP0" },
    body: { rt_cd: "1", msg1: "ALREADY IN USE appkey" },
  }));

  const status = client.status();
  assert.equal(status.state, "BLOCKED");
  assert.equal(status.blocked, true);
  assert.equal(status.blockedReason.code, "KIS_REALTIME_APPKEY_IN_USE");
  assert.match(status.blockedReason.message, /ALREADY IN USE/i);

  // 소켓이 닫혀도 재연결을 예약하지 않아야 한다.
  socket.close();
  await flush();
  client.scheduleReconnect();
  assert.deepEqual(scheduled, [], "차단 상태에서는 재연결을 예약하면 안 된다");

  // 운영자가 점유 세션을 정리한 뒤 해제할 수 있어야 한다.
  client.clearBlock();
  assert.equal(client.status().blocked, false);
  client.stop();
});

test("같은 에러 반복은 억제하되 발생 횟수는 유지한다", async () => {
  let now = 1_000_000;
  const emitted = [];
  const client = new KisRealtimeMarketDataClient({
    config,
    fetchImpl: async () => response({ approval_key: "APPROVAL-TOKEN" }),
    WebSocketImpl: FakeWebSocket,
    now: () => now,
    errorRepeatIntervalMs: 60_000,
  });
  client.on("errorState", (item) => emitted.push({ ...item }));

  for (let i = 0; i < 500; i += 1) {
    client.recordError(new Error("WebSocket 오류가 발생했습니다."), "KIS_REALTIME_SOCKET_ERROR");
    now += 100;
  }
  assert.equal(client.lastError.repeatCount, 500);
  assert.ok(emitted.length <= 2, `500건이 ${emitted.length}건으로 접혀야 한다`);

  // 다른 에러는 즉시 나가야 한다.
  client.recordError(new Error("다른 오류"), "KIS_REALTIME_OTHER");
  assert.equal(emitted.at(-1).code, "KIS_REALTIME_OTHER");
  assert.equal(emitted.at(-1).repeatCount, 1);
  client.stop();
});

// 2026-09-10 실전 발견: 구독 해제에 tr_type "0"을 보내 KIS가
// "JSON PARSING ERROR : invalid tr_type"으로 거절했다. 해제가 실패해도 클라이언트는
// activeSubscriptions에서 지워버려, 서버 쪽 구독만 남아 누적된다.
test("후보에서 빠진 종목은 tr_type 2로 구독을 해지한다", async () => {
  FakeWebSocket.instances = [];
  const client = new KisRealtimeMarketDataClient({
    config,
    fetchImpl: async () => response({ approval_key: "APPROVAL-TOKEN" }),
    WebSocketImpl: FakeWebSocket,
    setTimeoutImpl: () => null,
    clearTimeoutImpl: () => {},
  });
  client.watchSymbols([{ symbol: "005930", venue: "KRX" }]);
  await flush();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await flush();
  socket.sent.length = 0;

  // 005930을 빼고 000660을 넣는다.
  client.watchSymbols([{ symbol: "000660", venue: "KRX" }]);
  const frames = socket.sent.map((item) => JSON.parse(item));

  const unsubscribed = frames.filter((f) => f.body.input.tr_key === "005930");
  const subscribed = frames.filter((f) => f.body.input.tr_key === "000660");
  assert.equal(unsubscribed.length, 2, "빠진 종목의 호가·체결 둘 다 해지해야 한다");
  assert.equal(subscribed.length, 2, "새 종목의 호가·체결 둘 다 등록해야 한다");
  assert.ok(
    unsubscribed.every((f) => f.header.tr_type === "2"),
    `해지는 tr_type "2"여야 한다 (받은 값: ${unsubscribed.map((f) => f.header.tr_type).join(",")})`,
  );
  assert.ok(subscribed.every((f) => f.header.tr_type === "1"));
  assert.ok(
    frames.every((f) => ["1", "2"].includes(f.header.tr_type)),
    "KIS는 tr_type 1과 2만 허용한다",
  );
  client.stop();
});
