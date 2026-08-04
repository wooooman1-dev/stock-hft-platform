const BASELINE_EVENT = "BROKER_RECONCILIATION_BASELINE";
const MISMATCH_EVENT = "BROKER_RECONCILIATION_MISMATCH";
const ACKNOWLEDGED_EVENT = "BROKER_RECONCILIATION_ACKNOWLEDGED";

export class KisPaperReconciliationError extends Error {
  constructor(message, {
    code = "KIS_PAPER_RECONCILIATION_ERROR",
    statusCode = 409,
  } = {}) {
    super(message);
    this.name = "KisPaperReconciliationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class KisPaperReconciler {
  constructor({ journal, now = Date.now, brokerVisibilityGraceMs = 30_000 } = {}) {
    if (!journal || typeof journal.append !== "function" || typeof journal.readAll !== "function") {
      throw new TypeError("append/readAll을 제공하는 실행 저널이 필요합니다.");
    }
    if (typeof now !== "function") throw new TypeError("now는 함수여야 합니다.");
    if (!Number.isFinite(brokerVisibilityGraceMs) || brokerVisibilityGraceMs < 1_000) {
      throw new TypeError("brokerVisibilityGraceMs는 1000ms 이상의 값이어야 합니다.");
    }
    this.journal = journal;
    this.now = now;
    this.brokerVisibilityGraceMs = brokerVisibilityGraceMs;
    this.baselines = new Map();
    this.latchedDays = new Set();
    this.lastMismatchSignatureByDay = new Map();
    this.current = null;
    this.replayJournal();
  }

  status() {
    const day = koreaDateKey(this.now());
    const report = this.current?.day === day
      ? structuredClone(this.current)
      : unavailableReport(day, this.now(), "KIS 계좌 대조가 아직 실행되지 않았습니다.");
    const latched = this.latchedDays.has(day);
    const canAcknowledge = latched && report.status === "CONSISTENT";
    const effectiveStatus = canAcknowledge ? "RESOLVED_AWAITING_ACK" : report.status;
    return {
      ...report,
      status: effectiveStatus,
      rawStatus: report.status,
      latched,
      blocked: latched || report.status !== "CONSISTENT",
      canAcknowledge,
      baseline: structuredClone(this.baselines.get(day) ?? null),
    };
  }

  reconcile({ commands, orderHistory, balance, cancelableOrders } = {}) {
    const checkedAt = this.now();
    const day = koreaDateKey(checkedAt);
    if (!Array.isArray(orderHistory?.orders) || !Array.isArray(balance?.positions)) {
      return this.markUnavailable("KIS 주문내역 또는 잔고가 없어 계좌 대조를 완료할 수 없습니다.");
    }

    const orders = orderHistory.orders.map((order) => structuredClone(order));
    const positions = balance.positions.map((position) => structuredClone(position));
    const cancelable = Array.isArray(cancelableOrders)
      ? cancelableOrders.map((order) => structuredClone(order))
      : [];
    let baseline = this.baselines.get(day) ?? null;
    const baselineIssues = [];
    if (!baseline) {
      baseline = deriveBaseline({ day, checkedAt, positions, orders, issues: baselineIssues });
      if (baselineIssues.length === 0) {
        this.journal.append(BASELINE_EVENT, baseline, checkedAt);
        this.baselines.set(day, structuredClone(baseline));
      }
    }

    const report = evaluateState({
      day,
      checkedAt,
      commands,
      orders,
      positions,
      cancelableOrders: cancelable,
      baseline,
      baselineIssues,
      graceMs: this.brokerVisibilityGraceMs,
    });
    this.current = report;

    if (report.status === "MISMATCH") {
      this.latchedDays.add(day);
      const signature = mismatchSignature(report.issues);
      if (this.lastMismatchSignatureByDay.get(day) !== signature) {
        this.journal.append(MISMATCH_EVENT, {
          day,
          checkedAt,
          signature,
          issues: report.issues,
          summary: report.summary,
        }, checkedAt);
        this.lastMismatchSignatureByDay.set(day, signature);
      }
    }
    return this.status();
  }

  markUnavailable(error) {
    const day = koreaDateKey(this.now());
    const message = error instanceof Error ? error.message : String(error ?? "KIS 계좌 대조 실패");
    this.current = unavailableReport(day, this.now(), message);
    return this.status();
  }

  acknowledge() {
    const day = koreaDateKey(this.now());
    const report = this.current?.day === day ? this.current : null;
    if (!this.latchedDays.has(day)) return this.status();
    if (!report || report.status !== "CONSISTENT") {
      throw new KisPaperReconciliationError(
        "KIS 주문내역·잔고 불일치가 해소되지 않아 주문 차단을 해제할 수 없습니다.",
        { code: "KIS_PAPER_RECONCILIATION_UNRESOLVED", statusCode: 409 },
      );
    }
    this.journal.append(ACKNOWLEDGED_EVENT, {
      day,
      acknowledgedAt: this.now(),
      checkedAt: report.checkedAt,
      summary: report.summary,
    }, this.now());
    this.latchedDays.delete(day);
    this.lastMismatchSignatureByDay.delete(day);
    return this.status();
  }

  replayJournal() {
    for (const event of this.journal.readAll()) {
      const payload = event?.payload ?? {};
      if (event.type === BASELINE_EVENT && typeof payload.day === "string") {
        this.baselines.set(payload.day, structuredClone(payload));
      } else if (event.type === MISMATCH_EVENT && typeof payload.day === "string") {
        this.latchedDays.add(payload.day);
        if (typeof payload.signature === "string") {
          this.lastMismatchSignatureByDay.set(payload.day, payload.signature);
        }
      } else if (event.type === ACKNOWLEDGED_EVENT && typeof payload.day === "string") {
        this.latchedDays.delete(payload.day);
        this.lastMismatchSignatureByDay.delete(payload.day);
      }
    }
  }
}

function evaluateState({
  day,
  checkedAt,
  commands,
  orders,
  positions,
  cancelableOrders,
  baseline,
  baselineIssues,
  graceMs,
}) {
  const issues = [...baselineIssues];
  const pending = [];
  const states = commands instanceof Map ? [...commands.values()] : Array.isArray(commands) ? commands : [];
  const todayStates = states.filter((state) => String(state?.day ?? "") === day);
  const brokerByKey = new Map();
  const brokerByNumber = new Map();
  for (const order of orders) {
    const number = text(order?.orderNumber);
    if (!number) continue;
    brokerByKey.set(orderKey(order?.orderOrganizationNumber, number), order);
    if (!brokerByNumber.has(number)) brokerByNumber.set(number, []);
    brokerByNumber.get(number).push(order);
  }

  const trackedBrokerKeys = new Set();
  const trackedBrokerNumbers = new Set();
  for (const state of todayStates) {
    const ageMs = Math.max(0, checkedAt - number(state?.timestamp));
    if (state?.state === "UNKNOWN") {
      issues.push(issue(
        "UNKNOWN_COMMAND_RESULT",
        `실행 저널 주문 ${state.clientOrderId ?? state.commandId ?? "-"}의 증권사 결과가 불명확합니다.`,
        { clientOrderId: state?.clientOrderId ?? null },
      ));
      continue;
    }
    if (state?.state === "PENDING") {
      if (ageMs <= graceMs) {
        pending.push(issue(
          "JOURNAL_COMMAND_PENDING",
          `주문 ${state.clientOrderId ?? state.commandId ?? "-"}의 증권사 응답을 기다리는 중입니다.`,
          { clientOrderId: state?.clientOrderId ?? null, ageMs },
        ));
      } else {
        issues.push(issue(
          "JOURNAL_COMMAND_STALE",
          `주문 ${state.clientOrderId ?? state.commandId ?? "-"}이 ${Math.round(ageMs / 1000)}초 동안 완료되지 않았습니다.`,
          { clientOrderId: state?.clientOrderId ?? null, ageMs },
        ));
      }
      continue;
    }
    const response = state?.result ?? {};
    if (String(response?.status ?? "").toUpperCase() !== "ACCEPTED") continue;
    const brokerResult = response?.result ?? {};
    const orderNumber = text(brokerResult?.orderNumber);
    const organizationNumber = text(brokerResult?.orderOrganizationNumber);
    if (!orderNumber) {
      issues.push(issue(
        "JOURNAL_BROKER_ORDER_NUMBER_MISSING",
        `접수된 실행 저널 주문 ${state.clientOrderId ?? "-"}에 증권사 주문번호가 없습니다.`,
        { clientOrderId: state?.clientOrderId ?? null },
      ));
      continue;
    }
    trackedBrokerNumbers.add(orderNumber);
    trackedBrokerKeys.add(orderKey(organizationNumber, orderNumber));
    const brokerOrder = findBrokerOrder({
      brokerByKey,
      brokerByNumber,
      organizationNumber,
      orderNumber,
    });
    if (!brokerOrder) {
      if (ageMs <= graceMs) {
        pending.push(issue(
          "BROKER_ORDER_VISIBILITY_PENDING",
          `주문번호 ${orderNumber}의 KIS 주문내역 반영을 기다리는 중입니다.`,
          { orderNumber, organizationNumber, ageMs },
        ));
      } else {
        issues.push(issue(
          "JOURNAL_ORDER_MISSING_AT_BROKER",
          `실행 저널 주문번호 ${orderNumber}가 KIS 당일 주문내역에 없습니다.`,
          { orderNumber, organizationNumber, ageMs },
        ));
      }
      continue;
    }
    if (String(state?.operation ?? "").toUpperCase() === "SUBMIT") {
      compareSubmitFields(state?.request ?? {}, brokerOrder, issues);
    }
  }

  for (const order of orders) {
    const orderNumber = text(order?.orderNumber);
    if (!orderNumber) continue;
    const key = orderKey(order?.orderOrganizationNumber, orderNumber);
    if (trackedBrokerKeys.has(key) || trackedBrokerNumbers.has(orderNumber)) continue;
    issues.push(issue(
      "BROKER_ORDER_NOT_IN_JOURNAL",
      `KIS 주문번호 ${orderNumber}가 PulseHFT 실행 저널에 없습니다. 외부 주문 여부를 확인해야 합니다.`,
      {
        orderNumber,
        orderOrganizationNumber: text(order?.orderOrganizationNumber),
        symbol: text(order?.symbol),
        side: text(order?.side),
      },
    ));
  }

  if (baseline) comparePositions({ baseline, orders, positions, issues });
  compareCancelableOrders({ cancelableOrders, brokerByKey, brokerByNumber, issues });

  return {
    day,
    checkedAt,
    status: issues.length > 0 ? "MISMATCH" : pending.length > 0 ? "PENDING" : "CONSISTENT",
    issues,
    pending,
    summary: {
      journalCommandCount: todayStates.length,
      brokerOrderCount: orders.length,
      positionCount: positions.length,
      cancelableOrderCount: cancelableOrders.length,
      issueCount: issues.length,
      pendingCount: pending.length,
    },
  };
}

function compareSubmitFields(request, order, issues) {
  const requestSide = text(request?.side)?.toUpperCase() ?? null;
  const brokerSide = text(order?.side)?.toUpperCase() ?? null;
  if (requestSide && brokerSide && requestSide !== brokerSide) {
    issues.push(issue(
      "ORDER_SIDE_MISMATCH",
      `주문번호 ${order.orderNumber}의 매수·매도 방향이 실행 저널과 KIS에서 다릅니다.`,
      { orderNumber: order.orderNumber, journalSide: requestSide, brokerSide },
    ));
  }
  const requestSymbol = text(request?.symbol);
  const brokerSymbol = text(order?.symbol);
  if (requestSymbol && brokerSymbol && requestSymbol !== brokerSymbol) {
    issues.push(issue(
      "ORDER_SYMBOL_MISMATCH",
      `주문번호 ${order.orderNumber}의 종목코드가 실행 저널과 KIS에서 다릅니다.`,
      { orderNumber: order.orderNumber, journalSymbol: requestSymbol, brokerSymbol },
    ));
  }
  const requestQuantity = number(request?.quantity);
  const brokerQuantity = number(order?.orderQuantity);
  if (requestQuantity > 0 && brokerQuantity > 0 && requestQuantity !== brokerQuantity) {
    issues.push(issue(
      "ORDER_QUANTITY_MISMATCH",
      `주문번호 ${order.orderNumber}의 주문수량이 실행 저널 ${requestQuantity}주, KIS ${brokerQuantity}주로 다릅니다.`,
      { orderNumber: order.orderNumber, journalQuantity: requestQuantity, brokerQuantity },
    ));
  }
}

function comparePositions({ baseline, orders, positions, issues }) {
  const opening = new Map((baseline?.openingPositions ?? []).map((item) => [text(item?.symbol), number(item?.quantity)]));
  const fills = aggregateNetFills(orders);
  const actual = new Map(positions.map((item) => [text(item?.symbol), number(item?.quantity)]));
  const symbols = new Set([...opening.keys(), ...fills.keys(), ...actual.keys()]);
  symbols.delete(null);
  for (const symbol of symbols) {
    const expectedQuantity = (opening.get(symbol) ?? 0) + (fills.get(symbol) ?? 0);
    const actualQuantity = actual.get(symbol) ?? 0;
    if (expectedQuantity !== actualQuantity) {
      issues.push(issue(
        "POSITION_QUANTITY_MISMATCH",
        `${symbol} 예상 보유수량 ${expectedQuantity}주와 KIS 실제 보유수량 ${actualQuantity}주가 다릅니다.`,
        { symbol, expectedQuantity, actualQuantity },
      ));
    }
  }
}

function compareCancelableOrders({ cancelableOrders, brokerByKey, brokerByNumber, issues }) {
  for (const cancelable of cancelableOrders) {
    const orderNumber = text(cancelable?.orderNumber);
    if (!orderNumber) continue;
    const brokerOrder = findBrokerOrder({
      brokerByKey,
      brokerByNumber,
      organizationNumber: cancelable?.orderOrganizationNumber,
      orderNumber,
    });
    if (!brokerOrder) {
      issues.push(issue(
        "CANCELABLE_ORDER_NOT_IN_HISTORY",
        `취소 가능한 주문번호 ${orderNumber}가 KIS 당일 주문내역에 없습니다.`,
        { orderNumber },
      ));
      continue;
    }
    const cancelableQuantity = number(cancelable?.cancelableQuantity);
    const remainingQuantity = number(brokerOrder?.remainingQuantity);
    if (cancelableQuantity > remainingQuantity) {
      issues.push(issue(
        "CANCELABLE_QUANTITY_MISMATCH",
        `주문번호 ${orderNumber}의 취소가능수량 ${cancelableQuantity}주가 미체결수량 ${remainingQuantity}주보다 큽니다.`,
        { orderNumber, cancelableQuantity, remainingQuantity },
      ));
    }
  }
}

function deriveBaseline({ day, checkedAt, positions, orders, issues }) {
  const actual = new Map(positions.map((item) => [text(item?.symbol), number(item?.quantity)]));
  const fills = aggregateNetFills(orders);
  const symbols = new Set([...actual.keys(), ...fills.keys()]);
  symbols.delete(null);
  const openingPositions = [];
  for (const symbol of [...symbols].sort()) {
    const quantity = (actual.get(symbol) ?? 0) - (fills.get(symbol) ?? 0);
    if (!Number.isInteger(quantity) || quantity < 0) {
      issues.push(issue(
        "RECONCILIATION_BASELINE_INVALID",
        `${symbol} 장 시작 보유수량을 계산할 수 없습니다. 현재 잔고와 당일 체결내역을 확인해야 합니다.`,
        { symbol, calculatedOpeningQuantity: quantity },
      ));
      continue;
    }
    openingPositions.push({ symbol, quantity });
  }
  return { day, capturedAt: checkedAt, openingPositions };
}

function aggregateNetFills(orders) {
  const fills = new Map();
  for (const order of orders) {
    const symbol = text(order?.symbol);
    const side = text(order?.side)?.toUpperCase() ?? null;
    const executedQuantity = number(order?.executedQuantity);
    if (!symbol || executedQuantity <= 0 || !new Set(["BUY", "SELL"]).has(side)) continue;
    const signedQuantity = side === "BUY" ? executedQuantity : -executedQuantity;
    fills.set(symbol, (fills.get(symbol) ?? 0) + signedQuantity);
  }
  return fills;
}

function findBrokerOrder({ brokerByKey, brokerByNumber, organizationNumber, orderNumber }) {
  const exact = brokerByKey.get(orderKey(organizationNumber, orderNumber));
  if (exact) return exact;
  const candidates = brokerByNumber.get(String(orderNumber)) ?? [];
  return candidates.length === 1 ? candidates[0] : null;
}

function orderKey(organizationNumber, orderNumber) {
  return `${text(organizationNumber) ?? "*"}:${text(orderNumber) ?? ""}`;
}

function mismatchSignature(issues) {
  return JSON.stringify(issues.map((item) => ({
    code: item.code,
    details: item.details,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

function unavailableReport(day, checkedAt, message) {
  return {
    day,
    checkedAt,
    status: "UNAVAILABLE",
    issues: [issue("RECONCILIATION_UNAVAILABLE", message, {})],
    pending: [],
    summary: {
      journalCommandCount: 0,
      brokerOrderCount: 0,
      positionCount: 0,
      cancelableOrderCount: 0,
      issueCount: 1,
      pendingCount: 0,
    },
  };
}

function issue(code, message, details) {
  return { code, message, details: structuredClone(details ?? {}) };
}

function koreaDateKey(timestamp) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function text(value) {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result || null;
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}
