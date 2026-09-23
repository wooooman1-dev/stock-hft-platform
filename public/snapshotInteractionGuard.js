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
    "strategy-stop-loss",
    "strategy-take-profit",
    "strategy-trailing-stop",
    "strategy-max-holding-seconds",
  ]);
  const INTERACTION_TIMEOUT_MS = 15_000;
  const guardedSources = new Set();
  let interactionActive = false;
  let safetyTimeout = null;
  let deferredReleaseTimeout = null;

  // autoTradingPanel.js의 설정 필드(at-field-*)와 kisLiveOrderPanel.js의 취소
  // 주문 입력창(live-cancel-*)은 동적으로 생성되어 고정 ID 목록에 넣을 수 없다.
  // 접두어로 함께 보호한다 — 이 필드들에 포커스가 있는 동안에는 스냅샷이 오더라도
  // #app을 다시 그리지 않아, 타이핑이 끊기거나 스크롤이 흔들리는 일이 없다.
  const GUARDED_ID_PREFIXES = ["at-field-", "live-cancel-"];

  function isGuardedControl(target) {
    const id = target?.id;
    if (!id) return false;
    if (GUARDED_CONTROL_IDS.has(id)) return true;
    return GUARDED_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
  }

  function strategyActionElement(target) {
    if (target?.dataset?.strategyAction) return target;
    if (typeof target?.closest === "function") {
      return target.closest("[data-strategy-action]");
    }
    return null;
  }

  function isGuardedInteractionTarget(target) {
    return isGuardedControl(target) || Boolean(strategyActionElement(target));
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
    if (isGuardedInteractionTarget(event.target)) beginInteraction();
  }, true);

  document.addEventListener("click", (event) => {
    if (strategyActionElement(event.target)) endInteraction({ defer: true });
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
    if (isGuardedInteractionTarget(event.relatedTarget)) {
      beginInteraction();
      return;
    }
    endInteraction({ defer: true });
  }, true);

  document.addEventListener("pointercancel", (event) => {
    if (isGuardedInteractionTarget(event.target)) endInteraction({ defer: true });
  }, true);

  // app.js는 스냅샷마다 #app.innerHTML을 통째로 다시 그리는데, 그리기 직전에
  // 자신이 소유하지 않은 패널들(.auto-trading-panel, .kis-live-panel)을
  // node.remove()로 잠깐 #app에서 떼어냈다가 innerHTML 대입 후 다시 append한다.
  // 이 순간 문서 높이가 일시적으로 줄어들면서, 스크롤을 이미 아래로 많이
  // 내려놓은 상태였다면 브라우저가 스크롤 위치를 새 문서 높이에 맞춰 강제로
  // 잘라낸다(clamp) — 이후 콘텐츠가 다시 늘어나도 스크롤은 되돌아오지 않는다
  // (2026-09-16).
  //
  // 처음에는 Element.prototype.innerHTML/remove 자체를 전역으로 가로챘는데
  // (모든 페이지의 모든 요소, 즉 autoTradingPanel.js의 자체 폴링 렌더 같은
  // #app과 무관한 변경까지), 그 결과 자동매매 패널이 3초마다 자기 자신만
  // 다시 그릴 때도 매번 전체 창 스크롤을 "고정 후 복원"해버려서, 사용자가
  // 스크롤하는 도중에도 계속 특정 위치로 되돌아가는 원인이 됐다(2026-09-17).
  // #app 자신의 innerHTML 대입과, #app의 직계 자식이 떨어져 나가는 remove()만
  // 감시하도록 좁혀서 — 실제로 문서 높이가 줄어드는 그 순간에만 개입한다.
  const innerHTMLDescriptor =
    typeof Element !== "undefined" ? Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML") : null;
  const removeDescriptor =
    typeof Element !== "undefined" ? Object.getOwnPropertyDescriptor(Element.prototype, "remove") : null;
  if (
    innerHTMLDescriptor &&
    typeof innerHTMLDescriptor.set === "function" &&
    removeDescriptor &&
    typeof removeDescriptor.value === "function" &&
    typeof window !== "undefined" &&
    typeof document.getElementById === "function"
  ) {
    const appElement = document.getElementById("app");
    let pinnedScrollX = null;
    let pinnedScrollY = null;
    let settleTimer = null;

    const pinScrollIfNeeded = () => {
      if (pinnedScrollX === null) {
        pinnedScrollX = window.scrollX;
        pinnedScrollY = window.scrollY;
      }
    };

    // #app는 시세가 들어오는 동안 200ms 간격으로 계속 다시 그려진다. 그때마다
    // "고정 후 복원"을 걸면, 사용자가 마침 그 순간 휠로 스크롤하고 있어도
    // 브라우저의 진짜 클램프(문서 높이 축소)와 구분하지 못하고 사용자의 스크롤을
    // 되돌려버린다 — #app으로 범위를 좁혀도 렌더 자체가 너무 잦아서 여전히
    // 스크롤이 튀었다(2026-09-17). 사용자가 방금 직접 스크롤했다는 신호(휠·터치·
    // 스크롤 키)가 있으면 그 복원을 건너뛴다 — 그 경우의 위치 차이는 클램프가
    // 아니라 사용자의 의도이기 때문이다.
    let lastUserScrollAt = 0;
    const markUserScroll = () => { lastUserScrollAt = Date.now(); };
    const SCROLL_KEYS = new Set(["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "]);
    window.addEventListener("wheel", markUserScroll, { passive: true });
    window.addEventListener("touchmove", markUserScroll, { passive: true });
    window.addEventListener("keydown", (event) => {
      if (SCROLL_KEYS.has(event.key)) markUserScroll();
    });

    const scheduleScrollSettle = () => {
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        const scrolledByUserRecently = Date.now() - lastUserScrollAt < 300;
        if (
          !scrolledByUserRecently &&
          pinnedScrollX !== null &&
          (window.scrollX !== pinnedScrollX || window.scrollY !== pinnedScrollY)
        ) {
          window.scrollTo(pinnedScrollX, pinnedScrollY);
        }
        pinnedScrollX = null;
        pinnedScrollY = null;
        settleTimer = null;
      }, 150);
    };

    Object.defineProperty(Element.prototype, "innerHTML", {
      configurable: true,
      enumerable: innerHTMLDescriptor.enumerable,
      get: innerHTMLDescriptor.get,
      set(value) {
        // #app 자신이 통째로 다시 그려질 때만 개입한다. 그 외 위젯(자동매매
        // 패널 자신의 내부 innerHTML 등)이 스스로를 다시 그리는 건 문서 높이를
        // 줄이지 않으므로 스크롤을 건드릴 이유가 없다.
        if (this !== appElement) {
          innerHTMLDescriptor.set.call(this, value);
          return;
        }
        pinScrollIfNeeded();
        innerHTMLDescriptor.set.call(this, value);
        scheduleScrollSettle();
      },
    });

    Object.defineProperty(Element.prototype, "remove", {
      configurable: true,
      writable: true,
      enumerable: removeDescriptor.enumerable,
      value(...args) {
        // #app에서 직접 떨어져 나가는 요소(externalPanels)만 문서 높이를
        // 줄인다. 다른 곳에서의 remove()는 무관하다.
        if (this.parentElement !== appElement) {
          return removeDescriptor.value.apply(this, args);
        }
        pinScrollIfNeeded();
        const result = removeDescriptor.value.apply(this, args);
        scheduleScrollSettle();
        return result;
      },
    });
  }

  globalThis.EventSource = SnapshotInteractionGuardEventSource;
})();
