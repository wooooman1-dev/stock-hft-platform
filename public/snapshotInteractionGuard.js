(() => {
  const NativeEventSource = globalThis.EventSource;
  if (typeof NativeEventSource !== "function") return;

  const guardedSources = new Set();
  let orderTypeInteractionActive = false;
  let interactionTimeout = null;

  function callListener(listener, target, event) {
    if (typeof listener === "function") {
      listener.call(target, event);
      return;
    }
    listener?.handleEvent?.(event);
  }

  function flushPendingSnapshots() {
    queueMicrotask(() => {
      if (orderTypeInteractionActive) return;
      for (const source of guardedSources) source.flushPendingSnapshots();
    });
  }

  function beginOrderTypeInteraction() {
    orderTypeInteractionActive = true;
    if (interactionTimeout !== null) clearTimeout(interactionTimeout);
    interactionTimeout = setTimeout(() => {
      interactionTimeout = null;
      orderTypeInteractionActive = false;
      flushPendingSnapshots();
    }, 15_000);
  }

  function endOrderTypeInteraction() {
    if (interactionTimeout !== null) clearTimeout(interactionTimeout);
    interactionTimeout = null;
    orderTypeInteractionActive = false;
    flushPendingSnapshots();
  }

  class SnapshotInteractionGuardEventSource {
    static CONNECTING = NativeEventSource.CONNECTING;
    static OPEN = NativeEventSource.OPEN;
    static CLOSED = NativeEventSource.CLOSED;

    constructor(url, options) {
      this.nativeSource = new NativeEventSource(url, options);
      this.snapshotWrappers = new Map();
      this.pendingSnapshots = new Map();
      guardedSources.add(this);
    }

    get url() { return this.nativeSource.url; }
    get withCredentials() { return this.nativeSource.withCredentials; }
    get readyState() { return this.nativeSource.readyState; }

    get onopen() { return this.nativeSource.onopen; }
    set onopen(listener) { this.nativeSource.onopen = listener; }
    get onmessage() { return this.nativeSource.onmessage; }
    set onmessage(listener) { this.nativeSource.onmessage = listener; }
    get onerror() { return this.nativeSource.onerror; }
    set onerror(listener) { this.nativeSource.onerror = listener; }

    addEventListener(type, listener, options) {
      if (type !== "snapshot") {
        this.nativeSource.addEventListener(type, listener, options);
        return;
      }

      if (this.snapshotWrappers.has(listener)) return;
      const wrapped = (event) => {
        if (orderTypeInteractionActive) {
          this.pendingSnapshots.set(listener, event);
          return;
        }
        callListener(listener, this, event);
      };
      this.snapshotWrappers.set(listener, wrapped);
      this.nativeSource.addEventListener(type, wrapped, options);
    }

    removeEventListener(type, listener, options) {
      if (type !== "snapshot") {
        this.nativeSource.removeEventListener(type, listener, options);
        return;
      }

      const wrapped = this.snapshotWrappers.get(listener);
      if (!wrapped) return;
      this.nativeSource.removeEventListener(type, wrapped, options);
      this.snapshotWrappers.delete(listener);
      this.pendingSnapshots.delete(listener);
    }

    dispatchEvent(event) {
      return this.nativeSource.dispatchEvent(event);
    }

    close() {
      this.pendingSnapshots.clear();
      this.snapshotWrappers.clear();
      guardedSources.delete(this);
      this.nativeSource.close();
    }

    flushPendingSnapshots() {
      if (orderTypeInteractionActive || this.pendingSnapshots.size === 0) return;
      const pending = [...this.pendingSnapshots.entries()];
      this.pendingSnapshots.clear();
      for (const [listener, event] of pending) callListener(listener, this, event);
    }
  }

  document.addEventListener("pointerdown", (event) => {
    if (event.target?.id === "order-type") beginOrderTypeInteraction();
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.target?.id !== "order-type") return;
    if (event.key === "Escape") {
      endOrderTypeInteraction();
      return;
    }
    if (["Enter", " ", "ArrowDown", "ArrowUp", "F4"].includes(event.key)) {
      beginOrderTypeInteraction();
    }
  }, true);

  document.addEventListener("change", (event) => {
    if (event.target?.id === "order-type") endOrderTypeInteraction();
  }, true);

  document.addEventListener("focusout", (event) => {
    if (event.target?.id === "order-type") endOrderTypeInteraction();
  }, true);

  document.addEventListener("pointercancel", (event) => {
    if (event.target?.id === "order-type") endOrderTypeInteraction();
  }, true);

  globalThis.EventSource = SnapshotInteractionGuardEventSource;
})();
