(() => {
  const NativeEventSource = globalThis.EventSource;
  if (typeof NativeEventSource !== "function") return;

  const GUARDED_CONTROL_IDS = new Set([
    "order-type",
    "quantity",
    "limit-price",
    "strategy-entry-confidence",
    "strategy-exit-confidence",
    "strategy-max-spread",
    "strategy-order-quantity",
    "strategy-cooldown-seconds",
  ]);
  const INTERACTION_TIMEOUT_MS = 15_000;
  const guardedSources = new Set();
  let interactionActive = false;
  let safetyTimeout = null;
  let deferredReleaseTimeout = null;

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
    queueMicrotask(() => {
      if (interactionActive) return;
      for (const source of guardedSources) source.flushPendingSnapshots();
    });
  }

  function clearReleaseTimers() {
    if (safetyTimeout !== null) clearTimeout(safetyTimeout);
    if (deferredReleaseTimeout !== null) clearTimeout(deferredReleaseTimeout);
    safetyTimeout = null;
    deferredReleaseTimeout = null;
  }

  function finishInteraction() {
    clearReleaseTimers();
    interactionActive = false;
    flushPendingSnapshots();
  }

  function beginInteraction() {
    interactionActive = true;
    if (deferredReleaseTimeout !== null) clearTimeout(deferredReleaseTimeout);
    if (safetyTimeout !== null) clearTimeout(safetyTimeout);
    deferredReleaseTimeout = null;
    safetyTimeout = setTimeout(finishInteraction, INTERACTION_TIMEOUT_MS);
  }

  function endInteraction({ defer = false } = {}) {
    if (!defer) {
      finishInteraction();
      return;
    }
    if (deferredReleaseTimeout !== null) clearTimeout(deferredReleaseTimeout);
    deferredReleaseTimeout = setTimeout(finishInteraction, 0);
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
        if (interactionActive) {
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

    dispatchEvent(event) { return this.nativeSource.dispatchEvent(event); }

    close() {
      this.pendingSnapshots.clear();
      this.snapshotWrappers.clear();
      guardedSources.delete(this);
      this.nativeSource.close();
    }

    flushPendingSnapshots() {
      if (interactionActive || this.pendingSnapshots.size === 0) return;
      const pending = [...this.pendingSnapshots.entries()];
      this.pendingSnapshots.clear();
      for (const [listener, event] of pending) callListener(listener, this, event);
    }
  }

  document.addEventListener("pointerdown", (event) => {
    if (isGuardedControl(event.target)) beginInteraction();
  }, true);

  document.addEventListener("focusin", (event) => {
    if (isGuardedControl(event.target)) beginInteraction();
  }, true);

  document.addEventListener("input", (event) => {
    if (isGuardedControl(event.target)) beginInteraction();
  }, true);

  document.addEventListener("keydown", (event) => {
    if (!isGuardedControl(event.target)) return;
    if (event.key === "Escape") {
      endInteraction();
      return;
    }
    beginInteraction();
  }, true);

  document.addEventListener("change", (event) => {
    if (event.target?.id === "order-type") endInteraction();
  }, true);

  document.addEventListener("focusout", (event) => {
    if (!isGuardedControl(event.target)) return;
    if (isGuardedControl(event.relatedTarget)) {
      beginInteraction();
      return;
    }
    endInteraction({ defer: true });
  }, true);

  document.addEventListener("pointercancel", (event) => {
    if (isGuardedControl(event.target)) endInteraction({ defer: true });
  }, true);

  globalThis.EventSource = SnapshotInteractionGuardEventSource;
})();
