import { EventEmitter } from "node:events";
import {
  buildRealtimeSubscription,
  getRealtimeTrCodes,
  normalizeRealtimeBook,
  normalizeRealtimeTrade,
  parseRealtimeMessage,
} from "./lsProtocol.js";

const LIVE_URL = "wss://openapi.ls-sec.co.kr:9443/websocket";
const PAPER_URL = "wss://openapi.ls-sec.co.kr:29443/websocket";

export class LsRealtimeClient extends EventEmitter {
  constructor({
    authClient,
    environment = "paper",
    WebSocketImpl = globalThis.WebSocket,
    now = Date.now,
  }) {
    super();
    if (!authClient) throw new Error("LsRealtimeClient에는 authClient가 필요합니다.");
    this.authClient = authClient;
    this.environment = environment.toLowerCase();
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.socket = null;
    this.token = null;
    this.connected = false;
    this.subscriptions = new Map();
  }

  get url() { return this.environment === "live" ? LIVE_URL : PAPER_URL; }

  async connect() {
    if (this.connected && this.socket) return;
    if (typeof this.WebSocketImpl !== "function") throw new Error("WebSocket 구현이 필요합니다.");
    this.token = await this.authClient.getAccessToken();
    await new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(this.url);
      this.socket = socket;
      const onOpen = () => {
        this.connected = true;
        this.emit("status", { connected: true, state: "connected", url: this.url });
        for (const subscription of this.subscriptions.values()) this.sendSubscription(subscription, true);
        resolve();
      };
      const onError = () => {
        const error = new Error("LS WebSocket 연결에 실패했습니다.");
        this.emit("error", error);
        if (!this.connected) reject(error);
      };
      const onClose = () => {
        this.connected = false;
        this.emit("status", { connected: false, state: "disconnected", url: this.url });
      };
      const onMessage = (event) => this.handleMessage(event.data);
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
      socket.addEventListener("message", onMessage);
    });
  }

  subscribe({ trCode, symbol }) {
    const key = `${trCode}:${symbol}`;
    const subscription = { trCode, symbol };
    this.subscriptions.set(key, subscription);
    if (this.connected) this.sendSubscription(subscription, true);
  }

  unsubscribe({ trCode, symbol }) {
    const key = `${trCode}:${symbol}`;
    const subscription = this.subscriptions.get(key) ?? { trCode, symbol };
    if (this.connected) this.sendSubscription(subscription, false);
    this.subscriptions.delete(key);
  }

  sendSubscription(subscription, subscribe) {
    if (!this.socket || !this.token || this.socket.readyState !== this.WebSocketImpl.OPEN) return;
    const message = buildRealtimeSubscription({
      token: this.token,
      trCode: subscription.trCode,
      symbol: subscription.symbol,
      subscribe,
    });
    this.socket.send(JSON.stringify(message));
  }

  handleMessage(raw) {
    try {
      const message = parseRealtimeMessage(raw);
      const trCode = message?.header?.tr_cd;
      const allCodes = ["KOSPI", "KOSDAQ", "UNIFIED"].flatMap((market) => Object.values(getRealtimeTrCodes(market)));
      if (message?.body?.rsp_cd !== undefined) {
        this.emit("message", message);
      } else if (["H1_", "HA_", "UH1"].includes(trCode)) {
        this.emit("book", normalizeRealtimeBook(message));
      } else if (["S3_", "K3_", "US3"].includes(trCode)) {
        this.emit("trade", normalizeRealtimeTrade(message, this.now()));
      } else if (allCodes.includes(trCode)) {
        this.emit("message", message);
      } else {
        this.emit("message", message);
      }
    } catch (error) {
      this.emit("error", error instanceof Error ? error : new Error("LS 실시간 메시지 처리 오류"));
    }
  }

  close() {
    if (this.socket && this.socket.readyState === this.WebSocketImpl.OPEN) {
      for (const subscription of this.subscriptions.values()) this.sendSubscription(subscription, false);
    }
    this.socket?.close();
    this.socket = null;
    this.connected = false;
  }
}
