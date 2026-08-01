(() => {
  const NativeEventSource = globalThis.EventSource;
  if (typeof NativeEventSource !== "function") return;

  const GUARDED_CONTROL_IDS = new Set(["order-type", "quantity", "limit-price"]);
  const guardedSources = new Set();
  let orderEntryInteractionActive = false;
  let interactionTimeout = null;
  let flushTimeout = null;

  function isGuardedControl(target) {
    return GUARDED_CONTROL_IDS.has(target?.id);
  }

  function callListener(listener, target, event) {
    if (typeof listener === "function") {
      listener.call(target, event);
      return;
    }
    listener?.handleEvent?.(event);
  }

  function flushPendingSnapshots() {
    if (flushTimeout !== null) clearTimeout(flushTimeout);
    flushTimeout = setTimeout(() => {
      flushTimeout = null;
      if (orderEntryInteractionActive) return;
      for (const source of guardedSources) source.flushPendingSnapshots();
    }, 0);
  }

  function beginOrderEntryInteraction() {
    orderEntryInteractionActive = true;
    if (flushTimeout !== null) clearTimeout(flushTimeout);
    flushTimeout = null;
    if (interactionTimeout !== null) clearTimeout(interactionTimeout);
    interactionTimeout = setTimeout(() => {
      interactionTimeout = null;
      orderEntryInteractionActive = false;
      flushPendingSnapshots();
    }, 15_000);
  }

  function endOrderEntryInteraction() {
    if (interactionTimeout !== null) clearTimeout(interactionTimeout);
    interactionTimeout = null;
    orderEntryInteractionActive = false;
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
        if (orderEntryInteractionActive) {
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
      if (orderEntryInteractionActive || this.pendingSnapshots.size === 0) return;
      const pending = [...this.pendingSnapshots.entries()];
      this.pendingSnapshots.clear();
      for (const [listener, event] of pending) callListener(listener, this, event);
    }
  }

  document.addEventListener("pointerdown", (event) => {
    if (isGuardedControl(event.target)) beginOrderEntryInteraction();
  }, true);

  document.addEventListener("focusin", (event) => {
    if (isGuardedControl(event.target)) beginOrderEntryInteraction();
  }, true);

  document.addEventListener("input", (event) => {
    if (event.target?.id === "quantity" || event.target?.id === "limit-price") {
      beginOrderEntryInteraction();
    }
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.target?.id !== "order-type") return;
    if (event.key === "Escape") {
      endOrderEntryInteraction();
      return;
    }
    if (["Enter", " ", "ArrowDown", "ArrowUp", "F4"].includes(event.key)) {
      beginOrderEntryInteraction();
    }
  }, true);

  document.addEventListener("change", (event) => {
    if (event.target?.id === "order-type") endOrderEntryInteraction();
  }, true);

  document.addEventListener("focusout", (event) => {
    if (!isGuardedControl(event.target)) return;
    if (isGuardedControl(event.relatedTarget)) {
      beginOrderEntryInteraction();
      return;
    }
    endOrderEntryInteraction();
  }, true);

  document.addEventListener("pointercancel", (event) => {
    if (isGuardedControl(event.target)) endOrderEntryInteraction();
  }, true);

  globalThis.EventSource = SnapshotInteractionGuardEventSource;
})();
