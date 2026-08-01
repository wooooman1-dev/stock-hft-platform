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
  const microtasks = [];
  const timers = new Map();
  let timerSequence = 0;
  const context = vm.createContext({
    EventSource: FakeNativeEventSource,
    document,
    queueMicrotask: (callback) => microtasks.push(callback),
    setTimeout: (callback) => {
      const id = ++timerSequence;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  const source = await readFile(new URL("../../public/snapshotInteractionGuard.js", import.meta.url), "utf8");
  vm.runInContext(source, context);
  return {
    GuardedEventSource: context.EventSource,
    document,
    flushMicrotasks() {
      while (microtasks.length > 0) microtasks.shift()();
    },
    runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
  };
}

test("snapshot events are buffered from pointerdown until order type selection completes", async () => {
  const { GuardedEventSource, document, flushMicrotasks } = await loadGuard();
  const source = new GuardedEventSource("/api/events");
  const nativeSource = FakeNativeEventSource.instances[0];
  const received = [];
  source.addEventListener("snapshot", (event) => received.push(event.data));

  document.emit("pointerdown", { target: { id: "order-type" } });
  nativeSource.emit("snapshot", { type: "snapshot", data: "first" });
  nativeSource.emit("snapshot", { type: "snapshot", data: "latest" });
  assert.deepEqual(received, []);

  document.emit("change", { target: { id: "order-type" } });
  flushMicrotasks();
  assert.deepEqual(received, ["latest"]);

  nativeSource.emit("snapshot", { type: "snapshot", data: "live" });
  assert.deepEqual(received, ["latest", "live"]);
});

test("escape and timeout release a buffered select interaction", async () => {
  const { GuardedEventSource, document, flushMicrotasks, runTimers } = await loadGuard();
  const source = new GuardedEventSource("/api/events");
  const nativeSource = FakeNativeEventSource.instances[0];
  const received = [];
  source.addEventListener("snapshot", (event) => received.push(event.data));

  document.emit("keydown", { target: { id: "order-type" }, key: "Enter" });
  nativeSource.emit("snapshot", { type: "snapshot", data: "keyboard" });
  document.emit("keydown", { target: { id: "order-type" }, key: "Escape" });
  flushMicrotasks();
  assert.deepEqual(received, ["keyboard"]);

  document.emit("pointerdown", { target: { id: "order-type" } });
  nativeSource.emit("snapshot", { type: "snapshot", data: "timeout" });
  runTimers();
  flushMicrotasks();
  assert.deepEqual(received, ["keyboard", "timeout"]);
});

test("non-snapshot events and EventSource properties continue to pass through", async () => {
  const { GuardedEventSource, document } = await loadGuard();
  const source = new GuardedEventSource("/api/events", { withCredentials: true });
  const nativeSource = FakeNativeEventSource.instances[0];
  const received = [];

  document.emit("pointerdown", { target: { id: "order-type" } });
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
