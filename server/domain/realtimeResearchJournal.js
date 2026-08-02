import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export const REALTIME_RESEARCH_SCHEMA_VERSION = 1;

const EVENT_TYPES = new Set([
  "SESSION_STARTED",
  "SCANNER_REFRESH",
  "REALTIME_MARKET_DATA",
  "REALTIME_CONNECTION_STATUS",
  "REALTIME_ERROR",
  "REALTIME_STATE_TRANSITION",
  "SESSION_STOPPED",
]);
const FORBIDDEN_KEY = /(?:authorization|app.?key|app.?secret|access.?token|approval.?key|secretkey|client.?secret|account.?number)/i;

export class RealtimeResearchJournalError extends Error {
  constructor(message, code, cause = undefined) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RealtimeResearchJournalError";
    this.code = code;
    this.statusCode = 500;
  }
}

export class RealtimeResearchJournal {
  constructor(filePath, {
    enabled = true,
    now = Date.now,
    sessionId = randomUUID(),
    eventIdFactory = randomUUID,
    flushIntervalMs = 250,
    maxBatchEvents = 250,
    maxQueueEvents = 50_000,
    maxFileBytes = 512 * 1024 * 1024,
    secrets = [],
    appendFileImpl = appendFileSync,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = {}) {
    if (!filePath) throw new TypeError("실시간 연구 저널 파일 경로가 필요합니다.");
    if (typeof now !== "function") throw new TypeError("now는 함수여야 합니다.");
    if (typeof eventIdFactory !== "function") throw new TypeError("eventIdFactory는 함수여야 합니다.");
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new TypeError("sessionId는 비어 있지 않은 문자열이어야 합니다.");
    }
    this.filePath = filePath;
    this.enabled = Boolean(enabled);
    this.now = now;
    this.sessionId = sessionId;
    this.eventIdFactory = eventIdFactory;
    this.flushIntervalMs = positiveInteger(flushIntervalMs, "flushIntervalMs");
    this.maxBatchEvents = positiveInteger(maxBatchEvents, "maxBatchEvents");
    this.maxQueueEvents = positiveInteger(maxQueueEvents, "maxQueueEvents");
    this.maxFileBytes = positiveInteger(maxFileBytes, "maxFileBytes");
    this.secrets = [...new Set((Array.isArray(secrets) ? secrets : [])
      .filter((value) => typeof value === "string" && value.length > 0))];
    this.appendFileImpl = appendFileImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.sequence = 0;
    this.queue = [];
    this.queuedBytes = 0;
    this.bytesWritten = existsSync(filePath) ? statSync(filePath).size : 0;
    this.eventCount = 0;
    this.droppedEvents = 0;
    this.flushFailures = 0;
    this.typeCounts = Object.create(null);
    this.lastWriteAt = null;
    this.lastEventAt = null;
    this.lastError = null;
    this.state = this.enabled ? "RECORDING" : "DISABLED";
    this.timer = null;
    if (this.enabled) {
      this.timer = setIntervalImpl(() => this.flush(), this.flushIntervalMs);
      this.timer?.unref?.();
    }
  }

  append(type, payload = {}, timestamp = this.now()) {
    if (!this.enabled || this.state === "STOPPED") return null;
    if (!EVENT_TYPES.has(type)) {
      throw new RealtimeResearchJournalError(
        `지원하지 않는 실시간 연구 이벤트입니다: ${String(type)}`,
        "REALTIME_RESEARCH_INVALID_EVENT",
      );
    }
    if (!Number.isFinite(Number(timestamp))) {
      throw new RealtimeResearchJournalError(
        "실시간 연구 이벤트 timestamp는 유한한 숫자여야 합니다.",
        "REALTIME_RESEARCH_INVALID_EVENT",
      );
    }
    if (!isRecord(payload)) {
      throw new RealtimeResearchJournalError(
        "실시간 연구 이벤트 payload는 객체여야 합니다.",
        "REALTIME_RESEARCH_INVALID_EVENT",
      );
    }
    if (this.queue.length >= this.maxQueueEvents) {
      this.droppedEvents += 1;
      this.state = "BACKPRESSURE";
      return null;
    }

    const event = {
      schemaVersion: REALTIME_RESEARCH_SCHEMA_VERSION,
      eventId: String(this.eventIdFactory()),
      sessionId: this.sessionId,
      sequence: this.sequence + 1,
      timestamp: Number(timestamp),
      type,
      payload: sanitize(payload, this.secrets),
    };
    validateEvent(event, event.sequence, event.sequence);
    const line = `${JSON.stringify(event)}\n`;
    const lineBytes = Buffer.byteLength(line);
    if (this.bytesWritten + this.queuedBytes + lineBytes > this.maxFileBytes) {
      this.droppedEvents += 1;
      this.state = "LIMIT_REACHED";
      return null;
    }

    this.sequence = event.sequence;
    this.queue.push(line);
    this.queuedBytes += lineBytes;
    this.eventCount += 1;
    this.typeCounts[type] = (this.typeCounts[type] ?? 0) + 1;
    this.lastEventAt = event.timestamp;
    if (this.state === "BACKPRESSURE") this.state = "RECORDING";
    if (this.queue.length >= this.maxBatchEvents) this.flush();
    return structuredClone(event);
  }

  recordSessionStarted(payload = {}, timestamp) {
    return this.append("SESSION_STARTED", payload, timestamp);
  }

  recordScannerRefresh(payload, timestamp) {
    return this.append("SCANNER_REFRESH", payload, timestamp);
  }

  recordRealtimeMarketData(payload, timestamp) {
    return this.append("REALTIME_MARKET_DATA", payload, timestamp);
  }

  recordConnectionStatus(payload, timestamp) {
    return this.append("REALTIME_CONNECTION_STATUS", payload, timestamp);
  }

  recordError(payload, timestamp) {
    return this.append("REALTIME_ERROR", payload, timestamp);
  }

  recordStateTransition(payload, timestamp) {
    return this.append("REALTIME_STATE_TRANSITION", payload, timestamp);
  }

  flush() {
    if (!this.enabled || this.queue.length === 0) return this.status();
    const batch = this.queue.join("");
    const batchBytes = this.queuedBytes;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      this.appendFileImpl(this.filePath, batch, { encoding: "utf8" });
      this.queue = [];
      this.queuedBytes = 0;
      this.bytesWritten += batchBytes;
      this.lastWriteAt = this.now();
      if (this.state !== "LIMIT_REACHED") this.state = "RECORDING";
      this.lastError = null;
    } catch (error) {
      this.flushFailures += 1;
      this.state = "ERROR";
      this.lastError = {
        code: "REALTIME_RESEARCH_WRITE_FAILED",
        message: redactString(errorMessage(error), this.secrets),
        at: this.now(),
      };
    }
    return this.status();
  }

  stop(reason = "process shutdown") {
    if (!this.enabled || this.state === "STOPPED") return this.status();
    try {
      this.append("SESSION_STOPPED", { reason }, this.now());
    } catch {
      // 종료 중 기록 실패가 서버 종료를 막지 않도록 합니다.
    }
    if (this.timer) this.clearIntervalImpl(this.timer);
    this.timer = null;
    this.flush();
    if (this.state !== "ERROR" && this.state !== "LIMIT_REACHED") this.state = "STOPPED";
    return this.status();
  }

  status() {
    return {
      enabled: this.enabled,
      state: this.state,
      schemaVersion: REALTIME_RESEARCH_SCHEMA_VERSION,
      sessionId: this.enabled ? this.sessionId : null,
      fileName: this.enabled ? basename(this.filePath) : null,
      eventCount: this.eventCount,
      queuedEvents: this.queue.length,
      queuedBytes: this.queuedBytes,
      bytesWritten: this.bytesWritten,
      maxFileBytes: this.maxFileBytes,
      droppedEvents: this.droppedEvents,
      flushFailures: this.flushFailures,
      lastSequence: this.sequence,
      lastEventAt: this.lastEventAt,
      lastWriteAt: this.lastWriteAt,
      typeCounts: { ...this.typeCounts },
      lastError: this.lastError ? { ...this.lastError } : null,
      automaticOrderConnected: false,
    };
  }
}

export function createRealtimeResearchJournal({
  dataDir,
  enabled,
  config = null,
  env = process.env,
  now = Date.now,
} = {}) {
  if (!dataDir) throw new TypeError("dataDir가 필요합니다.");
  const recordingEnabled = enabled
    ?? parseBoolean(env.PULSEHFT_REALTIME_RECORDING_ENABLED, Boolean(config?.enabled));
  const sessionId = randomUUID();
  const stamp = koreaTimestamp(now());
  const filePath = join(dataDir, "realtime-research", `${stamp}-${sessionId}.jsonl`);
  return new RealtimeResearchJournal(filePath, {
    enabled: recordingEnabled,
    now,
    sessionId,
    flushIntervalMs: envInteger(
      env.PULSEHFT_REALTIME_RECORDING_FLUSH_MS,
      250,
      50,
      5_000,
    ),
    maxBatchEvents: envInteger(
      env.PULSEHFT_REALTIME_RECORDING_BATCH_EVENTS,
      250,
      1,
      10_000,
    ),
    maxQueueEvents: envInteger(
      env.PULSEHFT_REALTIME_RECORDING_MAX_QUEUE,
      50_000,
      1_000,
      1_000_000,
    ),
    maxFileBytes: envInteger(
      env.PULSEHFT_REALTIME_RECORDING_MAX_FILE_BYTES,
      512 * 1024 * 1024,
      1_048_576,
      10 * 1024 * 1024 * 1024,
    ),
    secrets: [config?.appKey, config?.appSecret],
  });
}

export function readRealtimeResearchEvents(filePath) {
  if (!filePath || !existsSync(filePath)) {
    throw new RealtimeResearchJournalError(
      "실시간 연구 저널 파일을 찾을 수 없습니다.",
      "REALTIME_RESEARCH_FILE_NOT_FOUND",
    );
  }
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new RealtimeResearchJournalError(
      `실시간 연구 저널을 읽을 수 없습니다: ${errorMessage(error)}`,
      "REALTIME_RESEARCH_READ_FAILED",
      error,
    );
  }
  if (content.length === 0) return [];
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const events = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].length === 0) throw invalidStoredEvent(index + 1, "빈 행입니다.");
    let event;
    try {
      event = JSON.parse(lines[index]);
    } catch (error) {
      throw new RealtimeResearchJournalError(
        `실시간 연구 저널 ${index + 1}행 JSON이 손상되었습니다: ${errorMessage(error)}`,
        "REALTIME_RESEARCH_READ_FAILED",
        error,
      );
    }
    validateEvent(event, index + 1, index + 1);
    events.push(event);
  }
  return structuredClone(events);
}

function validateEvent(event, expectedSequence, lineNumber) {
  if (!isRecord(event)) throw invalidStoredEvent(lineNumber, "객체가 아닙니다.");
  if (event.schemaVersion !== REALTIME_RESEARCH_SCHEMA_VERSION) {
    throw invalidStoredEvent(
      lineNumber,
      `지원하지 않는 schemaVersion ${String(event.schemaVersion)}입니다.`,
    );
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

function sanitize(value, secrets, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value, secrets);
  if (["number", "boolean"].includes(typeof value)) return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => sanitize(item, secrets, seen));
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) continue;
    result[key] = sanitize(item, secrets, seen);
  }
  seen.delete(value);
  return result;
}

function redactString(value, secrets) {
  let result = String(value);
  for (const secret of secrets) {
    if (secret) result = result.replaceAll(secret, "[REDACTED]");
  }
  return result;
}

function invalidStoredEvent(line, detail) {
  return new RealtimeResearchJournalError(
    `실시간 연구 저널 ${line}행 형식이 올바르지 않습니다: ${detail}`,
    "REALTIME_RESEARCH_READ_FAILED",
  );
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label}는 양의 정수여야 합니다.`);
  }
  return value;
}

function envInteger(value, fallback, minimum, maximum) {
  const number = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new RealtimeResearchJournalError(
      `환경변수 값은 ${minimum}~${maximum} 정수여야 합니다.`,
      "REALTIME_RESEARCH_INVALID_CONFIG",
    );
  }
  return number;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new RealtimeResearchJournalError(
    "PULSEHFT_REALTIME_RECORDING_ENABLED는 true 또는 false여야 합니다.",
    "REALTIME_RESEARCH_INVALID_CONFIG",
  );
}

function koreaTimestamp(timestamp) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}${get("month")}${get("day")}-${get("hour")}${get("minute")}${get("second")}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
