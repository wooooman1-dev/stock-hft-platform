import { randomUUID } from "node:crypto";
import { KisPaperReconciler } from "../../domain/kisPaperReconciler.js";
import {
  KisPaperOrderServiceError,
  finiteNumberOrNull,
  koreaDateKey,
  normalizeClientOrderId,
  normalizeReviseCancelRequest,
  normalizeSubmitRequest,
  replayExisting,
  safeError,
  safeRequest,
  unknownResponse,
} from "./kisPaperOrderSupport.js";

export { KisPaperOrderServiceError } from "./kisPaperOrderSupport.js";

const COMMAND_EVENT = "BROKER_ORDER_COMMAND";
const RESULT_EVENT = "BROKER_ORDER_RESULT";
const UNKNOWN_EVENT = "BROKER_ORDER_UNKNOWN";
const RISK_BASELINE_EVENT = "BROKER_RISK_BASELINE";

export class KisPaperOrderService {
  constructor({
    client,
    journal,
    limits,
    now = Date.now,
    commandIdFactory = randomUUID,
    onUnknownResult = () => {},
    reconciliationRefreshMs = 30_000,
  }) {
    if (!client || typeof client.submitOrder !== "function") {
      throw new TypeError("KIS paper client가 필요합니다.");
    }
    if (!journal || typeof journal.append !== "function" || typeof journal.readAll !== "function") {
      throw new TypeError("append/readAll을 제공하는 실행 저널이 필요합니다.");
    }
    if (!limits) throw new TypeError("KIS paper 안전 한도가 필요합니다.");
    if (typeof now !== "function") throw new TypeError("now는 함수여야 합니다.");
    if (typeof commandIdFactory !== "function") throw new TypeError("commandIdFactory는 함수여야 합니다.");
    if (typeof onUnknownResult !== "function") throw new TypeError("onUnknownResult는 함수여야 합니다.");
    if (!Number.isFinite(reconciliationRefreshMs) || reconciliationRefreshMs < 5_000) {
      throw new TypeError("reconciliationRefreshMs는 5000ms 이상의 값이어야 합니다.");
    }
    this.client = client;
    this.journal = journal;
    this.limits = structuredClone(limits);
    this.now = now;
    this.commandIdFactory = commandIdFactory;
    this.onUnknownResult = onUnknownResult;
    this.reconciliationRefreshMs = reconciliationRefreshMs;
    this.killSwitch = false;
    this.unknownResult = false;
    this.commands = new Map();
    this.dailyRiskBaselines = new Map();
    this.queue = Promise.resolve();
    this.reconciliationPromise = null;
    this.lastReconciliationRefreshAt = 0;
    this.replayJournal();
    this.markInterruptedCommandsUnknown();
    this.reconciler = typeof client.getDailyOrders === "function"
      && typeof client.getCancelableOrders === "function"
      ? new KisPaperReconciler({ journal, now })
      : null;
  }

  status() {
    const today = koreaDateKey(this.now());
    const todayCommands = [...this.commands.values()].filter((state) => state.day === today).length;
    const reconciliation = this.reconciler?.status() ?? {
      status: "DISABLED",
      rawStatus: "DISABLED",
      blocked: false,
      latched: false,
      canAcknowledge: false,
      issues: [],
      pending: [],
      summary: null,
      baseline: null,
      checkedAt: null,
      day: today,
    };
    return {
      killSwitch: this.killSwitch || this.unknownResult || reconciliation.blocked,
      manualKillSwitch: this.killSwitch,
      unknownResult: this.unknownResult,
      commandCount: this.commands.size,
      todayCommandCount: todayCommands,
      limits: structuredClone(this.limits),
      dailyRiskBaseline: structuredClone(this.dailyRiskBaselines.get(today) ?? null),
      reconciliation,
      automaticStrategyConnected: false,
    };
  }

  setKillSwitch(enabled) {
    if (!enabled && this.unknownResult) {
      throw new KisPaperOrderServiceError(
        "주문 결과 불명 상태가 남아 있어 킬 스위치를 해제할 수 없습니다. 증권사 주문내역을 먼저 대조해야 합니다.",
        { code: "KIS_PAPER_UNKNOWN_RESULT_UNRESOLVED", statusCode: 409 },
      );
    }
    if (!enabled && this.reconciler) {
      const reconciliation = this.reconciler.status();
      if (reconciliation.latched && reconciliation.canAcknowledge) {
        this.reconciler.acknowledge();
      }
      const afterAcknowledge = this.reconciler.status();
      if (afterAcknowledge.blocked) {
        throw new KisPaperOrderServiceError(
          reconciliationBlockMessage(afterAcknowledge),
          {
            code: reconciliationErrorCode(afterAcknowledge),
            statusCode: 409,
          },
        );
      }
    }
    this.killSwitch = Boolean(enabled);
    return this.status();
  }

  async getBalance() {
    const balance = await this.client.getBalance();
    await this.refreshReconciliation({ balance, force: false });
    return balance;
  }

  async submitOrder(input) {
    return this.enqueue(() => this.execute({
      operation: "SUBMIT",
      clientOrderId: normalizeClientOrderId(input?.clientOrderId),
      request: normalizeSubmitRequest(input),
      call: (request) => this.client.submitOrder(request),
    }));
  }

  async reviseOrder(input) {
    return this.enqueue(() => this.execute({
      operation: "REVISE",
      clientOrderId: normalizeClientOrderId(input?.clientOrderId),
      request: normalizeReviseCancelRequest(input, "REVISE"),
      call: (request) => this.client.reviseOrder(request),
    }));
  }

  async cancelOrder(input) {
    return this.enqueue(() => this.execute({
      operation: "CANCEL",
      clientOrderId: normalizeClientOrderId(input?.clientOrderId),
      request: normalizeReviseCancelRequest(input, "CANCEL"),
      call: (request) => this.client.cancelOrder(request),
    }));
  }

  enqueue(task) {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }

  async execute({ operation, clientOrderId, request, call }) {
    const existing = this.commands.get(clientOrderId);
    if (existing) return replayExisting(existing);
    await this.enforceSafety(operation, request);
    const timestamp = this.now();
    const command = {
      commandId: String(this.commandIdFactory()),
      clientOrderId,
      operation,
      request: safeRequest(request),
      timestamp,
      day: koreaDateKey(timestamp),
    };
    this.appendOrThrow(COMMAND_EVENT, command, timestamp, false);
    const state = { ...command, state: "PENDING", result: null, error: null };
    this.commands.set(clientOrderId, state);
    try {
      const result = await call(request);
      const normalized = {
        clientOrderId,
        operation,
        status: "ACCEPTED",
        replayed: false,
        result: structuredClone(result),
      };
      try {
        this.journal.append(RESULT_EVENT, {
          commandId: command.commandId,
          clientOrderId,
          operation,
          status: "ACCEPTED",
          result: structuredClone(result),
        }, this.now());
      } catch (error) {
        this.enterUnknownResult({ command, error, resultKnownButNotDurable: true });
        Object.assign(state, {
          state: "UNKNOWN",
          result: unknownResponse(command, error, false),
          error: safeError(error),
        });
        throw new KisPaperOrderServiceError(
          "모의주문은 증권사에서 접수됐지만 실행 저널 기록에 실패했습니다. 중복 주문 방지를 위해 주문 결과 불명 상태로 전환했습니다.",
          { code: "KIS_PAPER_RESULT_JOURNAL_FAILED", statusCode: 500, ambiguous: true },
        );
      }
      Object.assign(state, { state: "RESULT", result: normalized, error: null });
      this.lastReconciliationRefreshAt = 0;
      return structuredClone(normalized);
    } catch (error) {
      if (error instanceof KisPaperOrderServiceError && error.code === "KIS_PAPER_RESULT_JOURNAL_FAILED") {
        throw error;
      }
      const ambiguous = Boolean(error?.ambiguous);
      if (ambiguous) {
        this.enterUnknownResult({ command, error });
        const unknown = unknownResponse(command, error, false);
        Object.assign(state, { state: "UNKNOWN", result: unknown, error: safeError(error) });
        return structuredClone(unknown);
      }
      const rejected = {
        clientOrderId,
        operation,
        status: "REJECTED",
        replayed: false,
        error: safeError(error),
      };
      try {
        this.journal.append(RESULT_EVENT, {
          commandId: command.commandId,
          clientOrderId,
          operation,
          status: "REJECTED",
          error: rejected.error,
        }, this.now());
      } catch (journalError) {
        this.enterUnknownResult({ command, error: journalError, resultKnownButNotDurable: true });
        Object.assign(state, {
          state: "UNKNOWN",
          result: unknownResponse(command, journalError, false),
          error: safeError(journalError),
        });
        throw new KisPaperOrderServiceError(
          "증권사 거절 응답은 받았지만 실행 저널 기록에 실패했습니다. 중복 요청 방지를 위해 주문 결과 불명 상태로 전환했습니다.",
          { code: "KIS_PAPER_RESULT_JOURNAL_FAILED", statusCode: 500, ambiguous: true },
        );
      }
      Object.assign(state, { state: "RESULT", result: rejected, error: rejected.error });
      return structuredClone(rejected);
    }
  }

  async enforceSafety(operation, request) {
    if (operation === "CANCEL") return;
    await this.refreshReconciliation({ force: true });
    const status = this.status();
    if (status.killSwitch) {
      const reconciliation = status.reconciliation;
      const message = reconciliation?.blocked
        ? reconciliationBlockMessage(reconciliation)
        : "한국투자 모의주문 킬 스위치가 활성화되어 신규·정정 주문이 차단되었습니다.";
      throw new KisPaperOrderServiceError(message, {
        code: reconciliation?.blocked
          ? reconciliationErrorCode(reconciliation)
          : "KIS_PAPER_KILL_SWITCH",
        statusCode: 423,
      });
    }
    const quantity = Number(request.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > this.limits.maxOrderQuantity) {
      throw new KisPaperOrderServiceError(
        `주문 수량은 1주 이상 ${this.limits.maxOrderQuantity}주 이하여야 합니다.`,
        { code: "KIS_PAPER_ORDER_QUANTITY_LIMIT", statusCode: 400 },
      );
    }
    const riskPrice = request.type === "LIMIT"
      ? Number(request.limitPrice)
      : Number(request.referencePrice);
    if (!Number.isFinite(riskPrice) || riskPrice <= 0) {
      throw new KisPaperOrderServiceError(
        "시장가 주문은 안전 한도 계산을 위한 referencePrice가 필요합니다.",
        { code: "KIS_PAPER_REFERENCE_PRICE_REQUIRED", statusCode: 400 },
      );
    }
    const orderValue = quantity * riskPrice;
    if (orderValue > this.limits.maxOrderValue) {
      throw new KisPaperOrderServiceError(
        `주문 추정금액 ${orderValue}원이 최대 주문금액 ${this.limits.maxOrderValue}원을 초과합니다.`,
        { code: "KIS_PAPER_ORDER_VALUE_LIMIT", statusCode: 400 },
      );
    }
    const today = koreaDateKey(this.now());
    const todayCount = [...this.commands.values()].filter((state) => state.day === today).length;
    if (todayCount >= this.limits.maxDailyOrders) {
      throw new KisPaperOrderServiceError(
        `일일 주문 명령 한도 ${this.limits.maxDailyOrders}건에 도달했습니다.`,
        { code: "KIS_PAPER_DAILY_ORDER_LIMIT", statusCode: 429 },
      );
    }
    if (this.limits.maxDailyLoss > 0) {
      const balance = await this.client.getBalance();
      const summary = balance?.summary ?? {};
      const totalEvaluationAmount = finiteNumberOrNull(summary.totalEvaluationAmount);
      const evaluationProfitLoss = finiteNumberOrNull(summary.evaluationProfitLoss) ?? 0;
      let baseline = this.dailyRiskBaselines.get(today) ?? null;
      if (!baseline && totalEvaluationAmount !== null) {
        baseline = { day: today, totalEvaluationAmount, capturedAt: this.now() };
        this.appendOrThrow(RISK_BASELINE_EVENT, baseline, baseline.capturedAt, false);
        this.dailyRiskBaselines.set(today, structuredClone(baseline));
      }
      const baselineLoss = baseline && totalEvaluationAmount !== null
        ? Math.max(0, baseline.totalEvaluationAmount - totalEvaluationAmount)
        : 0;
      const evaluationLoss = Math.max(0, -evaluationProfitLoss);
      const effectiveLoss = Math.max(baselineLoss, evaluationLoss);
      if (effectiveLoss >= this.limits.maxDailyLoss) {
        this.killSwitch = true;
        throw new KisPaperOrderServiceError(
          `모의계좌 당일 손실 ${effectiveLoss}원이 일일 손실 한도 ${this.limits.maxDailyLoss}원에 도달했습니다.`,
          { code: "KIS_PAPER_DAILY_LOSS_LIMIT", statusCode: 423 },
        );
      }
    }
  }

  async refreshReconciliation({ balance = null, force = false } = {}) {
    if (!this.reconciler) return null;
    const now = this.now();
    if (!force && this.lastReconciliationRefreshAt > 0
      && now - this.lastReconciliationRefreshAt < this.reconciliationRefreshMs) {
      return this.reconciler.status();
    }
    if (this.reconciliationPromise) return this.reconciliationPromise;
    this.reconciliationPromise = this.performReconciliation({ balance }).finally(() => {
      this.reconciliationPromise = null;
    });
    return this.reconciliationPromise;
  }

  async performReconciliation({ balance = null } = {}) {
    try {
      const [balanceResult, orderHistory, cancelableOrders] = await Promise.all([
        balance ? Promise.resolve(balance) : this.client.getBalance(),
        this.client.getDailyOrders(),
        this.client.getCancelableOrders(),
      ]);
      const report = this.reconciler.reconcile({
        commands: this.commands,
        orderHistory,
        balance: balanceResult,
        cancelableOrders,
      });
      this.lastReconciliationRefreshAt = this.now();
      return report;
    } catch (error) {
      this.lastReconciliationRefreshAt = this.now();
      return this.reconciler.markUnavailable(error);
    }
  }

  enterUnknownResult({ command, error, resultKnownButNotDurable = false }) {
    const payload = {
      commandId: command.commandId,
      clientOrderId: command.clientOrderId,
      operation: command.operation,
      reason: resultKnownButNotDurable ? "RESULT_JOURNAL_FAILED" : "BROKER_RESPONSE_AMBIGUOUS",
      error: safeError(error),
    };
    try {
      this.journal.append(UNKNOWN_EVENT, payload, this.now());
    } catch {
      // 이미 주문 결과가 불명확한 상태이므로 추가 기록 실패가 원래 위험을 가리지 않게 한다.
    }
    this.unknownResult = true;
    this.killSwitch = true;
    try {
      this.onUnknownResult(structuredClone(payload));
    } catch {
      // safety callback must not mask state
    }
  }

  appendOrThrow(type, payload, timestamp, ambiguousIfFailed) {
    try {
      return this.journal.append(type, payload, timestamp);
    } catch (error) {
      const baselineFailure = type === RISK_BASELINE_EVENT;
      throw new KisPaperOrderServiceError(
        type === COMMAND_EVENT
          ? "실행 저널에 주문 명령을 기록하지 못해 증권사 요청을 보내지 않았습니다."
          : baselineFailure
            ? "실행 저널에 일일 위험 기준을 기록하지 못해 증권사 요청을 보내지 않았습니다."
            : "실행 저널에 주문 결과를 기록하지 못했습니다.",
        {
          code: type === COMMAND_EVENT
            ? "KIS_PAPER_COMMAND_JOURNAL_FAILED"
            : baselineFailure
              ? "KIS_PAPER_RISK_BASELINE_JOURNAL_FAILED"
              : "KIS_PAPER_RESULT_JOURNAL_FAILED",
          statusCode: 500,
          ambiguous: ambiguousIfFailed,
        },
      );
    }
  }

  replayJournal() {
    for (const event of this.journal.readAll()) {
      if (event.type === COMMAND_EVENT) {
        const payload = event.payload;
        if (!payload?.clientOrderId) continue;
        this.commands.set(payload.clientOrderId, {
          ...structuredClone(payload),
          state: "PENDING",
          result: null,
          error: null,
        });
      } else if (event.type === RESULT_EVENT) {
        const payload = event.payload;
        const state = this.commands.get(payload?.clientOrderId);
        if (!state) continue;
        state.state = "RESULT";
        state.result = payload.status === "ACCEPTED"
          ? {
            clientOrderId: payload.clientOrderId,
            operation: payload.operation,
            status: "ACCEPTED",
            replayed: false,
            result: structuredClone(payload.result),
          }
          : {
            clientOrderId: payload.clientOrderId,
            operation: payload.operation,
            status: "REJECTED",
            replayed: false,
            error: structuredClone(payload.error),
          };
        state.error = payload.error ? structuredClone(payload.error) : null;
      } else if (event.type === RISK_BASELINE_EVENT) {
        const payload = event.payload;
        if (typeof payload?.day !== "string") continue;
        const totalEvaluationAmount = finiteNumberOrNull(payload.totalEvaluationAmount);
        const capturedAt = finiteNumberOrNull(payload.capturedAt);
        if (totalEvaluationAmount === null || capturedAt === null) continue;
        this.dailyRiskBaselines.set(payload.day, {
          day: payload.day,
          totalEvaluationAmount,
          capturedAt,
        });
      } else if (event.type === UNKNOWN_EVENT) {
        const payload = event.payload;
        const state = this.commands.get(payload?.clientOrderId);
        if (!state) continue;
        state.state = "UNKNOWN";
        state.result = unknownResponse(state, payload.error, false);
        state.error = payload.error ? structuredClone(payload.error) : null;
        this.unknownResult = true;
        this.killSwitch = true;
      }
    }
  }

  markInterruptedCommandsUnknown() {
    for (const state of this.commands.values()) {
      if (state.state !== "PENDING") continue;
      const payload = {
        commandId: state.commandId,
        clientOrderId: state.clientOrderId,
        operation: state.operation,
        reason: "PROCESS_RESTART_WITHOUT_TERMINAL_RESULT",
        error: {
          code: "KIS_PAPER_INTERRUPTED_COMMAND",
          message: "재시작 전 증권사 요청의 최종 결과가 실행 저널에 기록되지 않았습니다.",
        },
      };
      this.journal.append(UNKNOWN_EVENT, payload, this.now());
      state.state = "UNKNOWN";
      state.error = payload.error;
      state.result = unknownResponse(state, payload.error, false);
      this.unknownResult = true;
      this.killSwitch = true;
      try {
        this.onUnknownResult(structuredClone(payload));
      } catch {
        // ignore callback failure
      }
    }
  }
}

function reconciliationErrorCode(reconciliation) {
  const status = String(reconciliation?.status ?? "UNAVAILABLE").toUpperCase();
  if (status === "MISMATCH" || status === "RESOLVED_AWAITING_ACK") {
    return "KIS_PAPER_RECONCILIATION_BLOCKED";
  }
  if (status === "PENDING") return "KIS_PAPER_RECONCILIATION_PENDING";
  return "KIS_PAPER_RECONCILIATION_UNAVAILABLE";
}

function reconciliationBlockMessage(reconciliation) {
  const status = String(reconciliation?.status ?? "UNAVAILABLE").toUpperCase();
  const firstIssue = reconciliation?.issues?.[0]?.message;
  const firstPending = reconciliation?.pending?.[0]?.message;
  if (status === "RESOLVED_AWAITING_ACK") {
    return "KIS 주문내역·잔고 불일치는 해소됐지만 사용자 확인 전까지 신규·정정 주문이 차단됩니다. 킬 스위치를 해제해 대조 결과를 확인하세요.";
  }
  if (status === "MISMATCH") {
    return `KIS 주문내역·잔고 불일치로 신규·정정 주문이 차단되었습니다.${firstIssue ? ` ${firstIssue}` : ""}`;
  }
  if (status === "PENDING") {
    return `KIS 증권사 반영 대기 중에는 추가 신규·정정 주문이 차단됩니다.${firstPending ? ` ${firstPending}` : ""}`;
  }
  return `KIS 주문내역·잔고 대조를 완료하지 못해 신규·정정 주문이 차단되었습니다.${firstIssue ? ` ${firstIssue}` : ""}`;
}
