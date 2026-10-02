import assert from "node:assert/strict";
import test from "node:test";
import {
  createKisPongWebSocketClass,
  isKisPingPongPayload,
} from "../integrations/kis/kisPongWebSocket.js";

class FakeBaseWebSocket {
  constructor() {
    this.sent = [];
    this.ponged = [];
  }

  send(data, ...args) {
    this.sent.push({ data, args });
    return "sent";
  }

  pong(data) {
    this.ponged.push(data);
    return "ponged";
  }
}

test("KIS PINGPONG JSON is sent as a WebSocket pong control frame", () => {
  const TestWebSocket = createKisPongWebSocketClass(FakeBaseWebSocket);
  const socket = new TestWebSocket();
  const heartbeat = JSON.stringify({ header: { tr_id: "PINGPONG" } });

  assert.equal(socket.send(heartbeat), "ponged");
  assert.deepEqual(socket.ponged, [heartbeat]);
  assert.deepEqual(socket.sent, []);
  assert.equal(socket.kisPongCount, 1);
  assert.equal(Number.isFinite(socket.kisLastPongAt), true);
});

test("ordinary KIS subscription JSON remains a normal text frame", () => {
  const TestWebSocket = createKisPongWebSocketClass(FakeBaseWebSocket);
  const socket = new TestWebSocket();
  const subscription = JSON.stringify({
    header: { tr_type: "1" },
    body: { input: { tr_id: "H0STCNT0", tr_key: "005930" } },
  });

  assert.equal(socket.send(subscription), "sent");
  assert.deepEqual(socket.sent, [{ data: subscription, args: [] }]);
  assert.deepEqual(socket.ponged, []);
  assert.equal(socket.kisPongCount, 0);
});

test("heartbeat detection supports strings and binary payloads without accepting malformed JSON", () => {
  const heartbeat = JSON.stringify({ header: { tr_id: "PINGPONG" } });
  assert.equal(isKisPingPongPayload(heartbeat), true);
  assert.equal(isKisPingPongPayload(Buffer.from(heartbeat)), true);
  assert.equal(isKisPingPongPayload("{not-json"), false);
  assert.equal(isKisPingPongPayload(JSON.stringify({ header: { tr_id: "H0STCNT0" } })), false);
});
