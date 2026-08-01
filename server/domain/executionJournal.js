import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const EXECUTION_JOURNAL_SCHEMA_VERSION = 1;

const EVENT_TYPES = new Set([
  "SESSION_STARTED",
  "ORDER_CREATED",
  "ORDER_EVENT",
  "FILL",
  "ACCOUNT_RESET",
]);

export class ExecutionJournalError extends Error {
  constructor(message, code, cause = undefined) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ExecutionJournalError";
    this.code = code;
    this.statusCode = 500;
  }
}

export class ExecutionJournal {
  constructor(filePath, {
    now = Date.now,
    sessionId = randomUUID(),
    eventIdFactory = randomUUID,
  } = {}) {
    if (!filePath) throw new TypeError("실행 저널 파일 경로가 필요합니다.");
    if (typeof now !== "function") throw new TypeError("now는 함수여야 합니다.");
    if (typeof eventIdFactory !== "function") throw new TypeError("eventIdFactory는 함수여야 합니다.");
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new TypeError("sessionId는 비어 있지 않은 문자열이어야 합니다.");
    }

    this.filePath = filePath;
    this.now = now;
    this.sessionId = sessionId;
    this.eventIdFactory = eventIdFactory;
    const existing = this.readAll();
    this.sequence = existing.at(-1)?.sequence ?? 0;
  }

  append(type, payload = {}, timestamp = this.now()) {
    if (!EVENT_TYPES.has(type)) {
      throw new ExecutionJournalError(
        `지원하지 않는 실행 저널 이벤트입니다: ${String(type)}`,
        "EXECUTION_JOURNAL_INVALID_EVENT",
      );
    }
    if (!Number.isFinite(Number(timestamp))) {
      throw new ExecutionJournalError(
        "실행 저널 timestamp는 유한한 숫자여야 합니다.",
        "EXECUTION_JOURNAL_INVALID_EVENT",
      );
    }
    if (!isRecord(payload)) {
      throw new ExecutionJournalError(
        "실행 저널 payload는 객체여야 합니다.",
        "EXECUTION_JOURNAL_INVALID_EVENT",
      );
    }

    const nextSequence = this.sequence + 1;
    const event = {
      schemaVersion: EXECUTION_JOURNAL_SCHEMA_VERSION,
      eventId: String(this.eventIdFactory()),
      sessionId: this.sessionId,
      sequence: nextSequence,
      timestamp: Number(timestamp),
      type,
      payload: structuredClone(payload),
    };
    validateStoredEvent(event, nextSequence, nextSequence);

    let line;
    try {
      line = `${JSON.stringify(event)}\n`;
    } catch (error) {
      throw new ExecutionJournalError(
        `실행 저널 이벤트를 직렬화할 수 없습니다: ${formatError(error)}`,
        "EXECUTION_JOURNAL_INVALID_EVENT",
        error,
      );
    }

    const directory = dirname(this.filePath);
    let descriptor;
    try {
      mkdirSync(directory, { recursive: true });
      descriptor = openSync(this.filePath, "a");
      writeFileSync(descriptor, line, { encoding: "utf8" });
      fsyncSync(descriptor);
    } catch (error) {
      throw new ExecutionJournalError(
        `실행 저널을 기록할 수 없습니다: ${formatError(error)}`,
        "EXECUTION_JOURNAL_WRITE_FAILED",
        error,
      );
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }

    this.sequence = nextSequence;
    return structuredClone(event);
  }

  readAll() {
    if (!existsSync(this.filePath)) return [];

    let content;
    try {
      content = readFileSync(this.filePath, "utf8");
    } catch (error) {
      throw new ExecutionJournalError(
        `실행 저널을 읽을 수 없습니다: ${formatError(error)}`,
        "EXECUTION_JOURNAL_READ_FAILED",
        error,
      );
    }
    if (content.length === 0) return [];

    const lines = content.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    const events = [];
    for (let index = 0; index < lines.length; index += 1) {
      const lineNumber = index + 1;
      if (lines[index].length === 0) {
        throw new ExecutionJournalError(
          `실행 저널 ${lineNumber}행이 비어 있습니다.`,
          "EXECUTION_JOURNAL_READ_FAILED",
        );
      }
      let event;
      try {
        event = JSON.parse(lines[index]);
      } catch (error) {
        throw new ExecutionJournalError(
          `실행 저널 ${lineNumber}행 JSON이 손상되었습니다: ${formatError(error)}`,
          "EXECUTION_JOURNAL_READ_FAILED",
          error,
        );
      }
      validateStoredEvent(event, lineNumber, lineNumber);
      events.push(event);
    }
    return structuredClone(events);
  }

  status() {
    return {
      enabled: true,
      schemaVersion: EXECUTION_JOURNAL_SCHEMA_VERSION,
      lastSequence: this.sequence,
      sessionId: this.sessionId,
    };
  }
}

export class ExecutionJournalRecorder {
  constructor(journal = null) {
    if (journal !== null && typeof journal?.append !== "function") {
      throw new TypeError("journal은 append 메서드를 제공해야 합니다.");
    }
    this.journal = journal;
    this.seenOrders = new Set();
    this.seenEventCounts = new Map();
  }

  recordSessionStarted(payload, timestamp) {
    if (!this.journal) return null;
    return this.journal.append("SESSION_STARTED", payload, timestamp);
  }

  capture(account) {
    if (!this.journal) return [];
    const appended = [];
    const orders = [...(account?.orders ?? [])]
      .sort((left, right) => left.sequence - right.sequence || left.createdAt - right.createdAt);

    for (const order of orders) {
      if (!this.seenOrders.has(order.id)) {
        appended.push(this.journal.append("ORDER_CREATED", summarizeOrder(order), order.createdAt));
        this.seenOrders.add(order.id);
      }

      const seenCount = this.seenEventCounts.get(order.id) ?? 0;
      let fillIndex = order.events
        .slice(0, seenCount)
        .filter((event) => event.type === "FILL")
        .length;

      for (let index = seenCount; index < order.events.length; index += 1) {
        const event = order.events[index];
        if (event.type === "FILL") {
          const fill = order.fills[fillIndex];
          if (!fill) {
            throw new ExecutionJournalError(
              `주문 ${order.id}의 체결 이벤트와 체결 상세가 일치하지 않습니다.`,
              "EXECUTION_JOURNAL_INVALID_EVENT",
            );
          }
          appended.push(this.journal.append("FILL", {
            orderId: order.id,
            clientOrderId: order.clientOrderId,
            source: order.source,
            status: event.status,
            reason: event.reason,
            fill: structuredClone(fill),
          }, event.timestamp));
          fillIndex += 1;
        } else {
          appended.push(this.journal.append("ORDER_EVENT", {
            orderId: order.id,
            clientOrderId: order.clientOrderId,
            source: order.source,
            eventIndex: index,
            event: structuredClone(event),
          }, event.timestamp));
        }
      }
      this.seenEventCounts.set(order.id, order.events.length);
    }

    return appended;
  }

  recordAccountReset(account, timestamp, reason = "사용자 모의계좌 초기화") {
    if (!this.journal) {
      this.clearTracking();
      return null;
    }
    const event = this.journal.append("ACCOUNT_RESET", {
      reason,
      before: {
        cash: Number(account?.cash ?? 0),
        realizedPnl: Number(account?.realizedPnl ?? 0),
        positionQuantity: Number(account?.position?.quantity ?? 0),
        positionAveragePrice: Number(account?.position?.averagePrice ?? 0),
        orderCount: Array.isArray(account?.orders) ? account.orders.length : 0,
        fillCount: Array.isArray(account?.fills) ? account.fills.length : 0,
      },
    }, timestamp);
    this.clearTracking();
    return event;
  }

  clearTracking() {
    this.seenOrders.clear();
    this.seenEventCounts.clear();
  }
}

function summarizeOrder(order) {
  return {
    orderId: order.id,
    clientOrderId: order.clientOrderId,
    createdAt: order.createdAt,
    side: order.side,
    type: order.type,
    timeInForce: order.timeInForce,
    source: order.source,
    requestedQuantity: order.requestedQuantity,
    referencePrice: order.referencePrice,
    limitPrice: order.limitPrice,
    initialStatus: "PENDING_SUBMIT",
  };
}

function validateStoredEvent(event, expectedSequence, lineNumber) {
  if (!isRecord(event)) {
    throw invalidStoredEvent(lineNumber, "객체가 아닙니다.");
  }
  if (event.schemaVersion !== EXECUTION_JOURNAL_SCHEMA_VERSION) {
    throw invalidStoredEvent(lineNumber, `지원하지 않는 schemaVersion ${String(event.schemaVersion)}입니다.`);
  }
  if (typeof event.eventId !== "string" || event.eventId.length === 0) {
    throw invalidStoredEvent(lineNumber, "eventId가 없습니다.");
  }
  if (typeof event.sessionId !== "string" || event.sessionId.length === 0) {
    throw invalidStoredEvent(lineNumber, "sessionId가 없습니다.");
  }
  if (!Number.isInteger(event.sequence) || event.sequence !== expectedSequence) {
    throw invalidStoredEvent(
      lineNumber,
      `sequence가 ${expectedSequence}이어야 하지만 ${String(event.sequence)}입니다.`,
    );
  }
  if (!Number.isFinite(event.timestamp)) {
    throw invalidStoredEvent(lineNumber, "timestamp가 유한한 숫자가 아닙니다.");
  }
  if (!EVENT_TYPES.has(event.type)) {
    throw invalidStoredEvent(lineNumber, `지원하지 않는 type ${String(event.type)}입니다.`);
  }
  if (!isRecord(event.payload)) {
    throw invalidStoredEvent(lineNumber, "payload가 객체가 아닙니다.");
  }
}

function invalidStoredEvent(lineNumber, detail) {
  return new ExecutionJournalError(
    `실행 저널 ${lineNumber}행 형식이 올바르지 않습니다: ${detail}`,
    "EXECUTION_JOURNAL_READ_FAILED",
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
