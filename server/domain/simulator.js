class SeededRandom {
  constructor(seed = 20260731) {
    this.state = seed >>> 0;
  }
  next() {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0xffffffff;
  }
  between(min, max) { return min + (max - min) * this.next(); }
  int(min, max) { return Math.floor(this.between(min, max + 1)); }
}

export class MarketSimulator {
  constructor(initialPrice) {
    this.tickSize = 100;
    this.random = new SeededRandom();
    this.price = Math.round(initialPrice / this.tickSize) * this.tickSize;
    this.drift = 0;
    this.trades = [];
    this.candles = [];
    this.activeCandle = null;
    this.tradeSequence = 0;
  }

  next(now = Date.now()) {
    this.drift = this.drift * 0.92 + this.random.between(-0.18, 0.18);
    const pressure = this.random.next() < 0.08 ? this.random.between(-1.8, 1.8) : 0;
    const moveProbability = Math.min(0.9, Math.abs(this.drift + pressure) * 0.24 + 0.17);
    if (this.random.next() < moveProbability) {
      const direction = this.drift + pressure + this.random.between(-0.5, 0.5) >= 0 ? 1 : -1;
      this.price = Math.max(this.tickSize, this.price + direction * this.tickSize);
    }

    const tradeCount = this.random.int(1, this.random.next() < 0.12 ? 6 : 3);
    for (let index = 0; index < tradeCount; index += 1) {
      const directionalBias = 0.5 + Math.max(-0.3, Math.min(0.3, this.drift * 0.25));
      const side = this.random.next() < directionalBias ? "BUY" : "SELL";
      const size = this.random.next() < 0.08 ? this.random.int(80, 420) : this.random.int(1, 65);
      const trade = {
        id: `sim-${now}-${this.tradeSequence++}`,
        timestamp: now - (tradeCount - index - 1) * 15,
        price: this.price,
        size,
        side,
      };
      this.trades.push(trade);
      this.updateCandle(trade);
    }

    this.trades = this.trades.slice(-240);
    this.candles = this.candles.slice(-180);
    return {
      timestamp: now,
      lastPrice: this.price,
      book: this.createOrderBook(),
      trades: [...this.trades],
      candles: [...this.candles, ...(this.activeCandle ? [this.activeCandle] : [])].slice(-180),
    };
  }

  createOrderBook() {
    const basePressure = Math.max(-0.65, Math.min(0.65, this.drift * 0.65));
    const bids = Array.from({ length: 10 }, (_, index) => {
      const nearWeight = Math.max(0.25, 1.2 - index * 0.08);
      return {
        price: this.price - (index + 1) * this.tickSize,
        size: Math.max(1, Math.round(this.random.between(100, 900) * (1 + basePressure * nearWeight))),
      };
    });
    const asks = Array.from({ length: 10 }, (_, index) => {
      const nearWeight = Math.max(0.25, 1.2 - index * 0.08);
      return {
        price: this.price + (index + 1) * this.tickSize,
        size: Math.max(1, Math.round(this.random.between(100, 900) * (1 - basePressure * nearWeight))),
      };
    });
    return { bids, asks };
  }

  updateCandle(trade) {
    const bucket = Math.floor(trade.timestamp / 1_000) * 1_000;
    if (!this.activeCandle || this.activeCandle.time !== bucket) {
      if (this.activeCandle) this.candles.push(this.activeCandle);
      this.activeCandle = {
        time: bucket,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: trade.size,
      };
      return;
    }
    this.activeCandle.high = Math.max(this.activeCandle.high, trade.price);
    this.activeCandle.low = Math.min(this.activeCandle.low, trade.price);
    this.activeCandle.close = trade.price;
    this.activeCandle.volume += trade.size;
  }
}
