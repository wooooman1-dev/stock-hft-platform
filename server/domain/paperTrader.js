export class PaperTrader {
  constructor(initialCash = 10_000_000) {
    this.limits = {
      maxOrderQuantity: 100,
      maxPositionQuantity: 200,
      maxPositionNotional: 20_000_000,
      dailyLossLimit: 500_000,
    };
    this.initialCash = initialCash;
    this.orderSequence = 0;
    this.account = this.createInitialAccount();
  }

  snapshot(lastPrice) {
    const marketValue = this.account.position.quantity * lastPrice;
    const unrealizedPnl = this.account.position.quantity > 0
      ? (lastPrice - this.account.position.averagePrice) * this.account.position.quantity
      : 0;
    return structuredClone({
      ...this.account,
      equity: this.account.cash + marketValue,
      unrealizedPnl,
    });
  }

  submit(input) {
    const rejection = this.validate(input);
    if (rejection) return this.recordRejected(input, rejection);

    const halfSpread = Math.max(input.tickSize / 2, input.spread / 2);
    const slippage = Math.max(input.tickSize, Math.ceil(halfSpread / input.tickSize) * input.tickSize);
    const filledPrice = input.side === "BUY"
      ? input.referencePrice + slippage
      : Math.max(input.tickSize, input.referencePrice - slippage);

    if (input.side === "BUY") {
      const cost = filledPrice * input.quantity;
      if (cost > this.account.cash) return this.recordRejected(input, "가용 현금 부족");
      const currentQuantity = this.account.position.quantity;
      const nextQuantity = currentQuantity + input.quantity;
      const totalCost = this.account.position.averagePrice * currentQuantity + filledPrice * input.quantity;
      this.account.cash -= cost;
      this.account.position = { quantity: nextQuantity, averagePrice: totalCost / nextQuantity };
    } else {
      if (input.quantity > this.account.position.quantity) {
        return this.recordRejected(input, "보유 수량보다 많은 매도 주문");
      }
      this.account.cash += filledPrice * input.quantity;
      this.account.realizedPnl += (filledPrice - this.account.position.averagePrice) * input.quantity;
      const remaining = this.account.position.quantity - input.quantity;
      this.account.position = {
        quantity: remaining,
        averagePrice: remaining === 0 ? 0 : this.account.position.averagePrice,
      };
    }

    return this.record({
      ...input,
      filledQuantity: input.quantity,
      filledPrice,
      status: "FILLED",
      reason: "모의 시장가 체결",
    });
  }

  reset() { this.account = this.createInitialAccount(); }

  validate(input) {
    if (input.killSwitch) return "킬 스위치 활성화";
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) return "수량은 양의 정수여야 함";
    if (input.quantity > this.limits.maxOrderQuantity) return "1회 최대 주문 수량 초과";
    if (this.account.realizedPnl <= -this.limits.dailyLossLimit) return "일일 손실 한도 도달";
    if (input.side === "BUY") {
      const nextQuantity = this.account.position.quantity + input.quantity;
      if (nextQuantity > this.limits.maxPositionQuantity) return "최대 포지션 수량 초과";
      if (nextQuantity * input.referencePrice > this.limits.maxPositionNotional) return "최대 포지션 금액 초과";
    }
    return null;
  }

  recordRejected(input, reason) {
    return this.record({ ...input, filledQuantity: 0, filledPrice: 0, status: "REJECTED", reason });
  }

  record(input) {
    const order = {
      id: `paper-${Date.now()}-${this.orderSequence++}`,
      timestamp: Date.now(),
      side: input.side,
      requestedQuantity: input.quantity,
      filledQuantity: input.filledQuantity,
      requestedPrice: input.referencePrice,
      filledPrice: input.filledPrice,
      status: input.status,
      reason: input.reason,
      source: input.source,
    };
    this.account.orders = [order, ...this.account.orders].slice(0, 50);
    return order;
  }

  createInitialAccount() {
    return {
      initialCash: this.initialCash,
      cash: this.initialCash,
      equity: this.initialCash,
      realizedPnl: 0,
      unrealizedPnl: 0,
      position: { quantity: 0, averagePrice: 0 },
      orders: [],
    };
  }
}
