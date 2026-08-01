import { EventEmitter } from "node:events";
import { MarketSimulator } from "../domain/simulator.js";

export class SimulationMarketDataSource extends EventEmitter {
  constructor(initialPrice, { intervalMs = 200 } = {}) {
    super();
    this.simulator = new MarketSimulator(initialPrice);
    this.intervalMs = intervalMs;
    this.timer = null;
    this.mode = "SIMULATION";
    this.provider = "INTERNAL_SIMULATOR";
    this.connected = false;
  }

  get tickSize() { return this.simulator.tickSize; }

  async start() {
    if (this.timer) return;
    this.connected = true;
    this.emit("status", { connected: true, state: "connected", provider: this.provider, mode: this.mode });
    this.emit("tick", this.simulator.next());
    this.timer = setInterval(() => this.emit("tick", this.simulator.next()), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.connected = false;
    this.emit("status", { connected: false, state: "stopped", provider: this.provider, mode: this.mode });
  }
}
