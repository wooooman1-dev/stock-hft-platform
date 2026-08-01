import assert from "node:assert/strict";
import test from "node:test";
import { LsRealtimeClient } from "../brokers/ls/lsRealtimeClient.js";

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open", {});
    });
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(payload) { this.sent.push(payload); }
  close() { this.readyState = 3; this.emit("close", {}); }
}

test("LS paper WebSocket connects to port 29443 and sends subscriptions", async () => {
  FakeWebSocket.instances = [];
  const client = new LsRealtimeClient({
    authClient: { getAccessToken: async () => "token" },
    environment: "paper",
    WebSocketImpl: FakeWebSocket,
    now: () => 1234,
  });
  client.on("error", () => {});

  await client.connect();
  client.subscribe({ trCode: "H1_", symbol: "005930" });

  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, "wss://openapi.ls-sec.co.kr:29443/websocket");
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    header: { token: "token", tr_type: "3" },
    body: { tr_cd: "H1_", tr_key: "005930" },
  });
});

test("LS WebSocket trade messages are normalized and emitted", async () => {
  FakeWebSocket.instances = [];
  const client = new LsRealtimeClient({
    authClient: { getAccessToken: async () => "token" },
    environment: "live",
    WebSocketImpl: FakeWebSocket,
    now: () => 1234,
  });
  client.on("error", () => {});
  const trades = [];
  client.on("trade", (trade) => trades.push(trade));

  await client.connect();
  const socket = FakeWebSocket.instances[0];
  socket.emit("message", {
    data: JSON.stringify({
      header: { tr_cd: "S3_", tr_key: "005930" },
      body: { shcode: "005930", price: "72100", cvolume: "7", cgubun: "+", chetime: "093001" },
    }),
  });

  assert.equal(socket.url, "wss://openapi.ls-sec.co.kr:9443/websocket");
  assert.deepEqual(trades[0], {
    symbol: "005930",
    timestamp: 1234,
    price: 72100,
    size: 7,
    side: "BUY",
    exchangeTime: "093001",
  });
});

test("LS subscription acknowledgements do not overwrite the order book", async () => {
  FakeWebSocket.instances = [];
  const client = new LsRealtimeClient({
    authClient: { getAccessToken: async () => "token" },
    environment: "paper",
    WebSocketImpl: FakeWebSocket,
  });
  client.on("error", () => {});
  const books = [];
  const messages = [];
  client.on("book", (book) => books.push(book));
  client.on("message", (message) => messages.push(message));

  await client.connect();
  const socket = FakeWebSocket.instances[0];
  socket.emit("message", {
    data: JSON.stringify({
      header: { tr_cd: "H1_", tr_key: "005930" },
      body: { rsp_cd: "00000", rsp_msg: "TR 등록 성공" },
    }),
  });

  assert.equal(books.length, 0);
  assert.equal(messages.length, 1);
});
