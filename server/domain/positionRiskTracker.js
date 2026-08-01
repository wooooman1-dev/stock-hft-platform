export class PositionRiskTracker {
  constructor() {
    this.reset();
  }

  update({ quantity, lastPrice, timestamp }) {
    const nextQuantity = Number(quantity);
    if (!Number.isInteger(nextQuantity) || nextQuantity < 0) {
      throw new TypeError("포지션 수량은 0 이상의 정수여야 합니다.");
    }

    if (nextQuantity === 0) {
      this.reset();
      return this.snapshot();
    }

    const price = Number(lastPrice);
    const time = Number(timestamp);
    if (!Number.isFinite(price) || price <= 0) {
      throw new TypeError("포지션 위험 추적에는 유효한 현재가격이 필요합니다.");
    }
    if (!Number.isFinite(time)) {
      throw new TypeError("포지션 위험 추적에는 유효한 시각이 필요합니다.");
    }

    if (this.quantity === 0) {
      this.openedAt = time;
      this.peakPrice = price;
    } else {
      this.peakPrice = Math.max(this.peakPrice, price);
    }
    this.quantity = nextQuantity;
    return this.snapshot();
  }

  reset() {
    this.quantity = 0;
    this.openedAt = null;
    this.peakPrice = null;
  }

  snapshot() {
    return {
      quantity: this.quantity,
      openedAt: this.openedAt,
      peakPrice: this.peakPrice,
    };
  }
}
