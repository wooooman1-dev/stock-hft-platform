const OPEN_STATUSES = new Set(["ACCEPTED", "PARTIALLY_FILLED"]);
const VALID_SIDES = new Set(["BUY", "SELL"]);
const VALID_TYPES = new Set(["MARKET", "LIMIT"]);

export class PaperOrderError extends Error {
  constructor(message, statusCode = 400, code = "PAPER_ORDER_ERROR") {
    super(message);
    this.name = "PaperOrderError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class PaperTrader {
  constructor(initialCash = 10_000_000, { now = Date.now } = {}) {
    this.limits = {
      maxOrderQuantity: 100,
      maxPositionQuantity: 200,
      maxPositionNotional: 20_000_000,
      dailyLossLimit: 500_000,
    };
    this.initialCash = initialCash;
    this.now = now;
    this.orderSequence = 0;
    this.fillSequence = 0;
    this.ordersById = new Map();
    this.ordersByClientId = new Map();
    this.account = this.createInitialAccount();
  }

  snapshot(lastPrice) {
    const marketValue = this.account.position.quantity * lastPrice;
    const unrealizedPnl = this.account.position.quantity > 0
      ? (lastPrice - this.account.position.averagePrice) * this.account.position.quantity
      : 0;
    const reservations = this.getReservations();
    return structuredClone({
      ...this.account,
      orders: this.account.orders.slice(0, 100).map((order) => this.cloneOrder(order)),
      equity: this.account.cash + marketValue,
      unrealizedPnl,
      reservedCash: reservations.cash,
      availableCash: Math.max(0, this.account.cash - reservations.cash),
      reservedSellQuantity: reservations.sellQuantity,
      sellableQuantity: Math.max(0, this.account.position.quantity - reservations.sellQuantity),
      openOrderCount: this.account.orders.filter((order) => order.isOpen).length,
    });
  }

  submit(input) {
    const normalized = this.normalizeInput(input);
    this.validateRequestShape(normalized);
    const duplicate = this.findDuplicate(normalized);
    if (duplicate) return duplicate;

    const order = this.createOrder(normalized);
    const rejection = this.validate(order, normalized.book);
    if (rejection) {
      order.rejectedQuantity = order.remainingQuantity;
      order.remainingQuantity = 0;
      this.transition(order, "REJECTED", rejection, normalized.timestamp, false);
      return this.cloneOrder(order);
    }

    this.transition(order, "ACCEPTED", "모의 주문 접수", normalized.timestamp);
    const workingBook = cloneBook(normalized.book);
    this.matchOrder(order, workingBook, normalized.timestamp);

    if (order.type === "MARKET" && order.remainingQuantity > 0) {
      if (order.filledQuantity > 0) {
        order.cancelledQuantity += order.remainingQuantity;
        order.remainingQuantity = 0;
        order.isOpen = false;
        this.transition(order, "PARTIALLY_FILLED", "IOC 미체결 잔량 취소", normalized.timestamp, false);
      } else {
        order.cancelledQuantity = order.requestedQuantity;
        order.remainingQuantity = 0;
        order.isOpen = false;
        this.transition(order, "CANCELLED", "매칭 가능한 반대 호가 없음", normalized.timestamp, false);
      }
    }

    return this.cloneOrder(order);
  }

  processOpenOrders({ book, timestamp = this.now() }) {
    const workingBook = cloneBook(book);
    const changed = [];
    const openOrders = this.account.orders
      .filter((order) => order.isOpen && order.type === "LIMIT")
      .sort((a, b) => a.createdAt - b.createdAt || a.sequence - b.sequence);

    for (const order of openOrders) {
      const before = order.filledQuantity;
      this.matchOrder(order, workingBook, timestamp);
      if (order.filledQuantity !== before) changed.push(this.cloneOrder(order));
    }
    return changed;
  }

  cancel(orderId, { reason = "사용자 취소", timestamp = this.now() } = {}) {
    const order = this.ordersById.get(orderId);
    if (!order) throw new PaperOrderError("주문을 찾을 수 없습니다.", 404, "ORDER_NOT_FOUND");
    if (!order.isOpen) return { ...this.cloneOrder(order), idempotentReplay: true };

    order.cancelledQuantity += order.remainingQuantity;
    order.remainingQuantity = 0;
    order.isOpen = false;
    this.transition(order, "CANCELLED", reason, timestamp, false);
    return this.cloneOrder(order);
  }

  reset() {
    this.orderSequence = 0;
    this.fillSequence = 0;
    this.ordersById.clear();
    this.ordersByClientId.clear();
    this.account = this.createInitialAccount();
  }

  normalizeInput(input) {
    const side = String(input.side ?? "").toUpperCase();
    const type = String(input.type ?? "MARKET").toUpperCase();
    const quantity = Number(input.quantity);
    const limitPrice = input.limitPrice === undefined || input.limitPrice === null || input.limitPrice === ""
      ? null
      : Number(input.limitPrice);
    const tickSize = Number(input.tickSize);
    const referencePrice = Number(input.referencePrice);
    const source = String(input.source ?? "MANUAL").toUpperCase();
    const timestamp = Number.isFinite(Number(input.timestamp)) ? Number(input.timestamp) : this.now();
    const clientOrderId = input.clientOrderId
      ? String(input.clientOrderId)
      : `paper-client-${timestamp}-${this.orderSequence}`;

    return {
      side,
      type,
      timeInForce: type === "MARKET" ? "IOC" : "GTC",
      quantity,
      limitPrice,
      tickSize,
      referencePrice,
      source,
      killSwitch: Boolean(input.killSwitch),
      marketDataAvailable: input.marketDataAvailable !== false,
      marketDataReason: input.marketDataReason,
      clientOrderId,
      timestamp,
      book: input.book,
    };
  }

  validateRequestShape(input) {
    if (!VALID_SIDES.has(input.side)) {
      throw new PaperOrderError("side는 BUY 또는 SELL이어야 합니다.", 400, "INVALID_ORDER_SIDE");
    }
    if (!VALID_TYPES.has(input.type)) {
      throw new PaperOrderError("type은 MARKET 또는 LIMIT이어야 합니다.", 400, "INVALID_ORDER_TYPE");
    }
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new PaperOrderError("quantity는 양의 정수여야 합니다.", 400, "INVALID_ORDER_QUANTITY");
    }
    if (!Number.isFinite(input.tickSize) || input.tickSize <= 0) {
      throw new PaperOrderError("유효한 호가 단위가 필요합니다.", 400, "INVALID_TICK_SIZE");
    }
    if (!Number.isFinite(input.referencePrice) || input.referencePrice <= 0) {
      throw new PaperOrderError("유효한 기준가격이 필요합니다.", 400, "INVALID_REFERENCE_PRICE");
    }
    if (input.type === "LIMIT") {
      if (!Number.isFinite(input.limitPrice) || input.limitPrice <= 0) {
        throw new PaperOrderError("지정가 주문에는 양의 limitPrice가 필요합니다.", 400, "INVALID_LIMIT_PRICE");
      }
      if (Math.abs(input.limitPrice / input.tickSize - Math.round(input.limitPrice / input.tickSize)) > 1e-9) {
        throw new PaperOrderError("지정가는 호가 단위에 맞아야 합니다.", 400, "INVALID_LIMIT_TICK");
      }
    }
  }

  findDuplicate(input) {
    const existing = this.ordersByClientId.get(input.clientOrderId);
    if (!existing) return null;
    const sameRequest = existing.side === input.side
      && existing.type === input.type
      && existing.requestedQuantity === input.quantity
      && existing.limitPrice === input.limitPrice;
    if (!sameRequest) {
      throw new PaperOrderError(
        "같은 clientOrderId로 다른 주문을 전송할 수 없습니다.",
        409,
        "CLIENT_ORDER_ID_CONFLICT",
      );
    }
    return { ...this.cloneOrder(existing), idempotentReplay: true };
  }

  createOrder(input) {
    const sequence = this.orderSequence++;
    const order = {
      id: `paper-order-${input.timestamp}-${sequence}`,
      clientOrderId: input.clientOrderId,
      sequence,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
      side: input.side,
      type: input.type,
      timeInForce: input.timeInForce,
      source: input.source,
      requestedQuantity: input.quantity,
      filledQuantity: 0,
      remainingQuantity: input.quantity,
      cancelledQuantity: 0,
      rejectedQuantity: 0,
      referencePrice: input.referencePrice,
      limitPrice: input.limitPrice,
      averageFilledPrice: 0,
      status: "PENDING_SUBMIT",
      isOpen: false,
      reason: "주문 생성",
      fills: [],
      events: [],
      tickSize: input.tickSize,
      killSwitch: input.killSwitch,
      marketDataAvailable: input.marketDataAvailable,
      marketDataReason: input.marketDataReason,
    };
    this.account.orders = [order, ...this.account.orders];
    this.ordersById.set(order.id, order);
    this.ordersByClientId.set(order.clientOrderId, order);
    assertOrderInvariant(order);
    return order;
  }

  validate(order, book) {
    if (order.killSwitch) return "킬 스위치 활성화";
    if (!order.marketDataAvailable) return order.marketDataReason ?? "시세 데이터 사용 불가";
    if (order.requestedQuantity > this.limits.maxOrderQuantity) return "1회 최대 주문 수량 초과";
    if (this.account.realizedPnl <= -this.limits.dailyLossLimit) return "일일 손실 한도 도달";

    if (order.type === "MARKET" && !hasOpposingLiquidity(order.side, book)) {
      return "매칭 가능한 반대 호가 없음";
    }

    const reservations = this.getReservations();
    if (order.side === "SELL") {
      const sellable = this.account.position.quantity - reservations.sellQuantity;
      if (order.requestedQuantity > sellable) return "매도 가능 수량 초과";
      return null;
    }

    const projectedQuantity = this.account.position.quantity + reservations.buyQuantity + order.requestedQuantity;
    if (projectedQuantity > this.limits.maxPositionQuantity) return "최대 포지션 수량 초과";

    const orderRiskPrice = order.type === "LIMIT"
      ? order.limitPrice
      : estimateMarketBuyCost(book, order.requestedQuantity).averagePrice || order.referencePrice;
    const projectedNotional = this.account.position.quantity * order.referencePrice
      + reservations.buyNotional
      + order.requestedQuantity * orderRiskPrice;
    if (projectedNotional > this.limits.maxPositionNotional) return "최대 포지션 금액 초과";

    const availableCash = this.account.cash - reservations.cash;
    const requiredCash = order.type === "LIMIT"
      ? order.limitPrice * order.requestedQuantity
      : estimateMarketBuyCost(book, order.requestedQuantity).cost;
    if (requiredCash > availableCash) return "가용 현금 부족";
    return null;
  }

  matchOrder(order, workingBook, timestamp) {
    if (!OPEN_STATUSES.has(order.status) || !order.isOpen || order.remainingQuantity <= 0) return;
    const levels = order.side === "BUY" ? workingBook.asks : workingBook.bids;

    for (const level of levels) {
      if (order.remainingQuantity <= 0) break;
      if (!isLevelExecutable(order, level)) break;
      if (!Number.isFinite(level.size) || level.size <= 0) continue;

      const quantity = Math.min(order.remainingQuantity, Math.floor(level.size));
      if (quantity <= 0) continue;
      this.applyFill(order, { price: level.price, quantity, timestamp });
      level.size -= quantity;
    }

    if (order.remainingQuantity === 0) {
      order.isOpen = false;
      this.transition(order, "FILLED", "모의 호가 체결 완료", timestamp, false);
    } else if (order.filledQuantity > 0) {
      this.transition(order, "PARTIALLY_FILLED", "모의 부분 체결", timestamp, true);
    }
  }

  applyFill(order, { price, quantity, timestamp }) {
    const value = price * quantity;
    if (order.side === "BUY") {
      const currentQuantity = this.account.position.quantity;
      const nextQuantity = currentQuantity + quantity;
      const totalCost = this.account.position.averagePrice * currentQuantity + value;
      this.account.cash -= value;
      this.account.position = { quantity: nextQuantity, averagePrice: totalCost / nextQuantity };
    } else {
      this.account.cash += value;
      this.account.realizedPnl += (price - this.account.position.averagePrice) * quantity;
      const remainingPosition = this.account.position.quantity - quantity;
      this.account.position = {
        quantity: remainingPosition,
        averagePrice: remainingPosition === 0 ? 0 : this.account.position.averagePrice,
      };
    }

    const previousValue = order.averageFilledPrice * order.filledQuantity;
    order.filledQuantity += quantity;
    order.remainingQuantity -= quantity;
    order.averageFilledPrice = (previousValue + value) / order.filledQuantity;
    order.updatedAt = timestamp;
    assertOrderInvariant(order);

    const fill = {
      id: `paper-fill-${timestamp}-${this.fillSequence++}`,
      orderId: order.id,
      timestamp,
      side: order.side,
      price,
      quantity,
      value,
    };
    order.fills.push(fill);
    this.account.fills = [fill, ...this.account.fills].slice(0, 200);
    this.appendEvent(order, "FILL", "체결", timestamp);
  }

  transition(order, status, reason, timestamp = this.now(), isOpen = status === "ACCEPTED" || status === "PARTIALLY_FILLED") {
    order.status = status;
    order.reason = reason;
    order.isOpen = isOpen;
    order.updatedAt = timestamp;
    order.closedAt = isOpen ? null : timestamp;
    assertOrderInvariant(order);
    this.appendEvent(order, status, reason, timestamp);
  }

  appendEvent(order, type, reason, timestamp) {
    order.events.push({
      timestamp,
      type,
      status: order.status,
      reason,
      filledQuantity: order.filledQuantity,
      remainingQuantity: order.remainingQuantity,
    });
  }

  getReservations() {
    let cash = 0;
    let buyQuantity = 0;
    let buyNotional = 0;
    let sellQuantity = 0;
    for (const order of this.account.orders) {
      if (!order.isOpen || order.remainingQuantity <= 0) continue;
      if (order.side === "BUY") {
        const price = order.limitPrice ?? order.referencePrice;
        cash += price * order.remainingQuantity;
        buyQuantity += order.remainingQuantity;
        buyNotional += price * order.remainingQuantity;
      } else {
        sellQuantity += order.remainingQuantity;
      }
    }
    return { cash, buyQuantity, buyNotional, sellQuantity };
  }

  cloneOrder(order) {
    const clone = structuredClone(order);
    delete clone.tickSize;
    delete clone.killSwitch;
    delete clone.marketDataAvailable;
    delete clone.marketDataReason;
    delete clone.sequence;
    return clone;
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
      fills: [],
    };
  }
}

function cloneBook(book) {
  return {
    bids: Array.isArray(book?.bids) ? book.bids.map((level) => ({ price: Number(level.price), size: Number(level.size) })) : [],
    asks: Array.isArray(book?.asks) ? book.asks.map((level) => ({ price: Number(level.price), size: Number(level.size) })) : [],
  };
}

function hasOpposingLiquidity(side, book) {
  const levels = side === "BUY" ? book?.asks : book?.bids;
  return Array.isArray(levels) && levels.some((level) => Number(level.price) > 0 && Number(level.size) > 0);
}

function isLevelExecutable(order, level) {
  if (!Number.isFinite(level.price) || level.price <= 0) return false;
  if (order.type === "MARKET") return true;
  return order.side === "BUY" ? level.price <= order.limitPrice : level.price >= order.limitPrice;
}

function estimateMarketBuyCost(book, quantity) {
  let remaining = quantity;
  let cost = 0;
  let filled = 0;
  for (const level of book?.asks ?? []) {
    const levelPrice = Number(level.price);
    const levelSize = Math.max(0, Math.floor(Number(level.size)));
    if (!Number.isFinite(levelPrice) || levelPrice <= 0 || levelSize <= 0) continue;
    const take = Math.min(remaining, levelSize);
    cost += take * levelPrice;
    filled += take;
    remaining -= take;
    if (remaining === 0) break;
  }
  return { cost, filled, averagePrice: filled > 0 ? cost / filled : 0 };
}

function assertOrderInvariant(order) {
  const quantities = [
    order.requestedQuantity,
    order.filledQuantity,
    order.remainingQuantity,
    order.cancelledQuantity,
    order.rejectedQuantity,
  ];
  if (!quantities.every((value) => Number.isInteger(value) && value >= 0)) {
    throw new Error(`주문 수량 불변조건 위반: ${order.id}`);
  }
  const accounted = order.filledQuantity
    + order.remainingQuantity
    + order.cancelledQuantity
    + order.rejectedQuantity;
  if (accounted !== order.requestedQuantity) {
    throw new Error(`주문 수량 합계 불변조건 위반: ${order.id}`);
  }
  if (order.isOpen && !OPEN_STATUSES.has(order.status)) {
    throw new Error(`열린 주문 상태 불변조건 위반: ${order.id}`);
  }
  if (!order.isOpen && order.status === "FILLED" && order.filledQuantity !== order.requestedQuantity) {
    throw new Error(`전량 체결 상태 불변조건 위반: ${order.id}`);
  }
}
