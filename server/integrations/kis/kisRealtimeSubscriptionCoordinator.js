export class KisRealtimeSubscriptionCoordinator {
  constructor(client) {
    if (!client || typeof client.watchSymbols !== "function") {
      throw new TypeError("KIS 실시간 client가 필요합니다.");
    }
    this.client = client;
    this.groups = new Map();
    this.views = new Map();
  }

  createView(name, { priority = 0 } = {}) {
    const key = String(name ?? "").trim();
    if (!key) throw new TypeError("실시간 구독 view 이름이 필요합니다.");
    if (this.views.has(key)) return this.views.get(key);
    const view = Object.freeze({
      status: () => this.client.status(),
      snapshot: (symbol) => this.client.snapshot(symbol),
      watchSymbols: (items) => this.setGroup(key, items, priority),
      start: () => this.client.start?.(),
      stop: () => this.clearGroup(key),
      on: (event, listener) => { this.client.on?.(event, listener); return view; },
      off: (event, listener) => { this.client.off?.(event, listener); return view; },
    });
    this.views.set(key, view);
    return view;
  }

  setGroup(name, items, priority = 0) {
    if (!Array.isArray(items)) throw new TypeError("실시간 구독 목록은 배열이어야 합니다.");
    this.groups.set(name, { priority: Number(priority) || 0, items: structuredClone(items) });
    return this.sync();
  }

  clearGroup(name) {
    this.groups.delete(name);
    return this.sync();
  }

  sync() {
    const maximum = Math.max(1, Number(this.client.status()?.maxSymbols) || 1);
    const merged = [];
    const seen = new Set();
    const groups = [...this.groups.values()].sort((a, b) => b.priority - a.priority);
    for (const group of groups) {
      for (const raw of group.items) {
        const item = typeof raw === "string" ? { symbol: raw, venue: "KRX" } : raw;
        const symbol = String(item?.symbol ?? "").trim().toUpperCase();
        const venue = String(item?.venue ?? "KRX").trim().toUpperCase();
        const key = `${venue}:${symbol}`;
        if (!symbol || seen.has(key)) continue;
        seen.add(key);
        merged.push({ symbol, venue });
        if (merged.length >= maximum) break;
      }
      if (merged.length >= maximum) break;
    }
    return this.client.watchSymbols(merged);
  }

  stop() {
    this.groups.clear();
    this.views.clear();
    return this.client.stop?.();
  }
}
