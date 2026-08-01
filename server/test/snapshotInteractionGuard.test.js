import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

class FakeNativeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances = [];

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.withCredentials = Boolean(options?.withCredentials);
    this.readyState = FakeNativeEventSource.OPEN;
    this.listeners = new Map();
    this.closed = false;
    FakeNativeEventSource.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
  }

  dispatchEvent(event) {
    this.emit(event.type, event);
    return true;
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener.call(this, event);
  }

  close() {
    this.closed = true;
    this.readyState = FakeNativeEventSource.CLOSED;
  }
}

function createDocument() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      const registered = listeners.get(type) ?? [];
      registered.push(listener);
      listeners.set(type, registered);
    },
    emit(type, event) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}

async function loadGuard() {
  FakeNativeEventSource.instances = [];
  const document = createDocument();
  const timers = new Map();
  let timerSequence = 0;
  const context = vm.createContext({
    EventSource: FakeNativeEventSource,
    document,
    setTimeout: (callback, delay = 0) => {
      const id = ++timerSequence;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  const source = await readFile(new URL("../../public/snapshotInteractionGuard.js", import.meta.url), "utf8");
  vm.runInContext(source, context);
  return {
    GuardedEventSource: context.EventSource,
    document,
    runTimers(delay) {
      const entries = [...timers.entries()].filter(([, timer]) => delay === undefined || timer.delay === delay);
      for (const [id, timer] of entries) {
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

test("snapshot events are buffered until order type selection completes", async () => {
  const { GuardedEventSource, document, runTimers } = await loadGuard();
  const source = new GuardedEventSource("/api/events");
  const nativeSource = FakeNativeEventSource.instances[0];
  const received = [];
  source.addEventListener("snapshot", (event) => received.push(event.data));

  document.emit("pointerdown", { target: { id: "order-type" } });
  nativeSource.emit("snapshot", { type: "snapshot", data: "first" });
  nativeSource.emit("snapshot", { type: "snapshot", data: "latest" });
  assert.deepEqual(received, []);

  document.emit("change", { target: { id: "order-type" } });
  runTimers(0);
  assert.deepEqual(received, ["latest"]);

  nativeSource.emit("snapshot", { type: "snapshot", data: "live" });
  assert.deepEqual(received, ["latest", "live"]);
});

test("quantity and limit price editing buffer snapshots until focus leaves", async () => {
  const { GuardedEventSource, document, runTimers } = await loadGuard();
  const source = new GuardedEventSource("/api/events");
  const nativeSource = FakeNativeEventSource.instances[0];
  const received = [];
  source.addEventListener("snapshot", (event) => received.push(event.data));

  document.emit("focusin", { target: { id: "limit-price" } });
  document.emit("input", { target: { id: "limit-price" } });
  nativeSource.emit("snapshot", { type: "snapshot", data: "during-price-entry" });
  assert.deepEqual(received, []);

  document.emit("focusout", { target: { id: "limit-price" }, relatedTarget: { id: "quantity" } });
  nativeSource.emit("snapshot", { type: "snapshot", data: "during-quantity-entry" });
  runTimers(0);
  assert.deepEqual(received, []);

  document.emit("focusout", { target: { id: "quantity" }, relatedTarget: { id: "buy-button" } });
  assert.deepEqual(received, []);
  runTimers(0);
  assert.deepEqual(received, ["during-quantity-entry"]);
});

test("zero-delay flush defers DOM replacement until after focusout", async () => {
  const { GuardedEventSource, document, runTimers } = await loadGuard();
  const source = new GuardedEventSource("/api/events");
  const nativeSource = FakeNativeEventSource.instances[0];
  const received = [];
  source.addEventListener("snapshot", (event) => received.push(event.data));

  document.emit("focusin", { target: { id: "limit-price" } });
  nativeSource.emit("snapshot", { type: "snapshot", data: "pending" });
  document.emit("focusout", { target: { id: "limit-price" }, relatedTarget: { dataset: { action: "buy" } } });
  assert.deepEqual(received, []);
  runTimers(0);
  assert.deepEqual(received, ["pending"]);
});

test("escape and timeout release buffered interactions", async () => {
  const { GuardedEventSource, document, runTimers } = await loadGuard();
  const source = new GuardedEventSource("/api/events");
  const nativeSource = FakeNativeEventSource.instances[0];
  const received = [];
  source.addEventListener("snapshot", (event) => received.push(event.data));

  document.emit("keydown", { target: { id: "order-type" }, key: "Enter" });
  nativeSource.emit("snapshot", { type: "snapshot", data: "keyboard" });
  document.emit("keydown", { target: { id: "order-type" }, key: "Escape" });
  runTimers(0);
  assert.deepEqual(received, ["keyboard"]);

  document.emit("focusin", { target: { id: "limit-price" } });
  nativeSource.emit("snapshot", { type: "snapshot", data: "timeout" });
  runTimers(15_000);
  runTimers(0);
  assert.deepEqual(received, ["keyboard", "timeout"]);
});

test("non-snapshot events and EventSource properties continue to pass through", async () => {
  const { GuardedEventSource, document } = await loadGuard();
  const source = new GuardedEventSource("/api/events", { withCredentials: true });
  const nativeSource = FakeNativeEventSource.instances[0];
  const received = [];

  document.emit("pointerdown", { target: { id: "limit-price" } });
  source.addEventListener("notice", (event) => received.push(event.data));
  nativeSource.emit("notice", { type: "notice", data: "immediate" });
  assert.deepEqual(received, ["immediate"]);
  assert.equal(source.url, "/api/events");
  assert.equal(source.withCredentials, true);
  assert.equal(source.readyState, FakeNativeEventSource.OPEN);

  const onerror = () => {};
  source.onerror = onerror;
  assert.equal(nativeSource.onerror, onerror);
  source.close();
  assert.equal(nativeSource.closed, true);
});
