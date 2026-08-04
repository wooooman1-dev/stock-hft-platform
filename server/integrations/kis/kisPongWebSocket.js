import WebSocket from "ws";

export function isKisPingPongPayload(value) {
  const raw = messageText(value);
  if (!raw || raw[0] !== "{") return false;
  try {
    const payload = JSON.parse(raw);
    return String(payload?.header?.tr_id ?? "").trim() === "PINGPONG";
  } catch {
    return false;
  }
}

export function createKisPongWebSocketClass(BaseWebSocket) {
  if (typeof BaseWebSocket !== "function") {
    throw new TypeError("BaseWebSocket 생성자가 필요합니다.");
  }

  return class KisPongWebSocket extends BaseWebSocket {
    constructor(...args) {
      super(...args);
      this.kisPongCount = 0;
      this.kisLastPongAt = null;
    }

    send(data, ...args) {
      if (!isKisPingPongPayload(data)) return super.send(data, ...args);
      if (typeof this.pong !== "function") {
        throw new TypeError("KIS PINGPONG 응답에는 WebSocket pong() 지원이 필요합니다.");
      }
      this.kisPongCount += 1;
      this.kisLastPongAt = Date.now();
      return this.pong(data);
    }
  };
}

export const KisPongWebSocket = createKisPongWebSocketClass(WebSocket);

function messageText(value) {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf8");
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
  }
  return null;
}
