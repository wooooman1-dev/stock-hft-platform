import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ExecutionJournal,
  ExecutionJournalError,
} from "../domain/executionJournal.js";
import { MarketRuntime } from "../domain/runtime.js";

function withTemporaryDirectory(callback) {
  const directory = mkdtempSync(join(tmpdir(), "pulsehft-journal-"));
  try { return callback(directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

function makeIdFactory(prefix = "event") {
  let sequence = 0;
  return () => `${prefix}-${sequence++}`;
}

test("execution journal appends durable JSONL events and restores the sequence", () => {
  withTemporaryDirectory((directory) => {
    const filePath = join(directory, "execution-journal.jsonl");
    const first = new ExecutionJournal(filePath, {
      now: () => 1_000,
      sessionId: "session-one",
      eventIdFactory: makeIdFactory("first"),
    });
    first.append("SESSION_STARTED", { mode: "SIMULATION" });
    first.append("ORDER_CREATED", { orderId: "order-one" }, 1_001);

    const restored = new ExecutionJournal(filePath, {
      now: () => 2_000,
      sessionId: "session-two",
      eventIdFactory: makeIdFactory("second"),
    });
    assert.equal(restored.status().lastSequence, 2);
    restored.append("ORDER_EVENT", {
      orderId: "order-one",
      event: { type: "FILLED" },
    });

    const events = restored.readAll();
    assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
    assert.deepEqual(events.map((event) => event.type), [
      "SESSION_STARTED",
      "ORDER_CREATED",
      "ORDER_EVENT",
    ]);
    assert.equal(events[0].sessionId, "session-one");
    assert.equal(events[2].sessionId, "session-two");
    assert.equal(readFileSync(filePath, "utf8").trim().split(/\r?\n/).length, 3);
  });
});

test("execution journal persists and restores reconciliation lifecycle events", () => {
  withTemporaryDirectory((directory) => {
    const filePath = join(directory, "execution-journal.jsonl");
    const journal = new ExecutionJournal(filePath, {
      now: () => 3_000,
      sessionId: "reconciliation-session",
      eventIdFactory: makeIdFactory("reconciliation"),
    });
    journal.append("BROKER_RECONCILIATION_BASELINE", {
      day: "2026-08-04",
      openingPositions: [],
    });
    journal.append("BROKER_RECONCILIATION_MISMATCH", {
      day: "2026-08-04",
      signature: "external-order",
      issues: [],
      summary: {},
    }, 3_001);
    journal.append("BROKER_RECONCILIATION_ACKNOWLEDGED", {
      day: "2026-08-04",
      acknowledgedAt: 3_002,
      summary: {},
    }, 3_002);

    const restored = new ExecutionJournal(filePath, {
      now: () => 4_000,
      sessionId: "restored-reconciliation-session",
      eventIdFactory: makeIdFactory("restored-reconciliation"),
    });
    assert.equal(restored.status().lastSequence, 3);
    assert.deepEqual(restored.readAll().map((event) => event.type), [
      "BROKER_RECONCILIATION_BASELINE",
      "BROKER_RECONCILIATION_MISMATCH",
      "BROKER_RECONCILIATION_ACKNOWLEDGED",
    ]);
  });
});

test("execution journal rejects corrupt JSON and broken sequence without truncating it", () => {
  withTemporaryDirectory((directory) => {
    const filePath = join(directory, "execution-journal.jsonl");
    writeFileSync(filePath, "{broken\n", "utf8");
    assert.throws(
      () => new ExecutionJournal(filePath),
      (error) => error instanceof ExecutionJournalError
        && error.code === "EXECUTION_JOURNAL_READ_FAILED",
    );
    assert.equal(readFileSync(filePath, "utf8"), "{broken\n");

    writeFileSync(filePath, `${JSON.stringify({
      schemaVersion: 1,
      eventId: "event-two",
      sessionId: "session",
      sequence: 2,
      timestamp: 1_000,
      type: "SESSION_STARTED",
      payload: {},
    })}\n`, "utf8");
    assert.throws(
      () => new ExecutionJournal(filePath),
      (error) => error.code === "EXECUTION_JOURNAL_READ_FAILED" && /sequence/.test(error.message),
    );
  });
});

test("runtime records created, accepted, fill and filled events in lifecycle order", () => {
  withTemporaryDirectory((directory) => {
    const filePath = join(directory, "execution-journal.jsonl");
    const journal = new ExecutionJournal(filePath, {
      now: () => 10_000,
      sessionId: "runtime-session",
      eventIdFactory: makeIdFactory("runtime"),
    });
    const runtime = new MarketRuntime("005930", "삼성전자", 70_000, {
      now: () => 10_000,
      executionJournal: journal,
    });

    const order = runtime.submitOrder({
      side: "BUY",
      type: "MARKET",
      quantity: 1,
      clientOrderId: "journal-buy-one",
      timestamp: 10_001,
    });
    assert.equal(order.status, "FILLED");

    const events = journal.readAll();
    assert.deepEqual(events.map((event) => event.type), [
      "ORDER_CREATED",
      "ORDER_EVENT",
      "FILL",
      "ORDER_EVENT",
    ]);
    assert.equal(events[0].payload.clientOrderId, "journal-buy-one");
    assert.equal(events[1].payload.event.type, "ACCEPTED");
    assert.equal(events[2].payload.fill.quantity, 1);
    assert.equal(events[3].payload.event.type, "FILLED");

    const beforeReplay = events.length;
    const replay = runtime.submitOrder({
      side: "BUY",
      type: "MARKET",
      quantity: 1,
      clientOrderId: "journal-buy-one",
      timestamp: 10_001,
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(journal.readAll().length, beforeReplay);
  });
});

test("paper account reset is journaled before in-memory state is cleared", () => {
  withTemporaryDirectory((directory) => {
    const journal = new ExecutionJournal(join(directory, "execution-journal.jsonl"), {
      now: () => 20_000,
      sessionId: "reset-session",
      eventIdFactory: makeIdFactory("reset"),
    });
    const runtime = new MarketRuntime("005930", "삼성전자", 70_000, {
      now: () => 20_000,
      executionJournal: journal,
    });
    runtime.submitOrder({
      side: "BUY",
      type: "MARKET",
      quantity: 2,
      clientOrderId: "before-reset",
      timestamp: 20_001,
    });

    runtime.resetPaperAccount();
    const events = journal.readAll();
    const reset = events.at(-1);
    assert.equal(reset.type, "ACCOUNT_RESET");
    assert.equal(reset.payload.before.positionQuantity, 2);
    assert.equal(reset.payload.before.orderCount, 1);
    assert.equal(runtime.snapshot().account.position.quantity, 0);
  });
});

test("runtime enables the kill switch when execution journal capture fails", () => {
  const failingJournal = {
    append() {
      throw new ExecutionJournalError("disk failure", "EXECUTION_JOURNAL_WRITE_FAILED");
    },
  };
  const runtime = new MarketRuntime("005930", "삼성전자", 70_000, {
    now: () => 30_000,
    executionJournal: failingJournal,
  });

  assert.throws(
    () => runtime.submitOrder({
      side: "BUY",
      type: "MARKET",
      quantity: 1,
      clientOrderId: "journal-failure",
      timestamp: 30_001,
    }),
    (error) => error.code === "EXECUTION_JOURNAL_WRITE_FAILED",
  );
  assert.equal(runtime.snapshot().system.killSwitch, true);
  assert.equal(runtime.snapshot().system.autoPaperTrading, false);
});

// 회귀 방지: app.js가 기록하는 이벤트 타입이 EVENT_TYPES 화이트리스트에 빠지면
// 서버가 기동 중 죽는다(2026-09-07 LIVE_SHARED_QUOTE_CREDENTIAL_ENABLED 사고).
// 테스트가 소스를 직접 훑어 새 이벤트 등록 누락을 잡는다.
test("every journal event appended by app.js is a registered event type", () => {
  const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const appended = [...appSource.matchAll(/(?:Journal|journal)\.append\(\s*"([A-Z_]+)"/g)]
    .map((match) => match[1]);
  assert.ok(appended.length > 0, "app.js에서 저널 append 호출을 찾지 못했습니다.");

  withTemporaryDirectory((directory) => {
    const journal = new ExecutionJournal(join(directory, "event-type-check.jsonl"));
    for (const type of new Set(appended)) {
      assert.doesNotThrow(
        () => journal.append(type, {}),
        `app.js가 기록하는 ${type}이 EVENT_TYPES에 등록되지 않았습니다.`,
      );
    }
  });
});

test("journal accepts the shared quote credential opt-in event", () => {
  withTemporaryDirectory((directory) => {
    const path = join(directory, "shared-credential.jsonl");
    const journal = new ExecutionJournal(path);
    journal.append("LIVE_SHARED_QUOTE_CREDENTIAL_ENABLED", {
      processId: 1234,
      orderEnabled: true,
      credentialSource: "ENV",
    });
    const written = readFileSync(path, "utf8").trim().split("\n");
    const last = JSON.parse(written[written.length - 1]);
    assert.equal(last.type, "LIVE_SHARED_QUOTE_CREDENTIAL_ENABLED");
    assert.equal(last.payload.orderEnabled, true);
  });
});
