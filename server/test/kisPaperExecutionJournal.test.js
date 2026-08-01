import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExecutionJournal } from "../domain/executionJournal.js";

function tempJournal() {
  const directory = mkdtempSync(join(tmpdir(), "pulsehft-paper-journal-"));
  return {
    directory,
    path: join(directory, "execution-journal.jsonl"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("execution journal persists broker command/result events with continuous sequence", () => {
  const temp = tempJournal();
  try {
    const journal = new ExecutionJournal(temp.path, {
      now: () => 1000,
      sessionId: "session-a",
      eventIdFactory: (() => { let id = 0; return () => `event-${++id}`; })(),
    });
    journal.append("BROKER_ORDER_COMMAND", { clientOrderId: "paper-1", operation: "SUBMIT" }, 1001);
    journal.append("BROKER_ORDER_RESULT", { clientOrderId: "paper-1", status: "ACCEPTED" }, 1002);
    journal.append("BROKER_ORDER_UNKNOWN", { clientOrderId: "paper-2", status: "UNKNOWN_RESULT" }, 1003);
    journal.append("BROKER_RISK_BASELINE", { day: "2026-08-01", totalEvaluationAmount: 1000000, capturedAt: 1004 }, 1004);

    const reopened = new ExecutionJournal(temp.path, {
      now: () => 2000,
      sessionId: "session-b",
      eventIdFactory: () => "event-next",
    });
    assert.deepEqual(reopened.readAll().map((event) => [event.sequence, event.type]), [
      [1, "BROKER_ORDER_COMMAND"],
      [2, "BROKER_ORDER_RESULT"],
      [3, "BROKER_ORDER_UNKNOWN"],
      [4, "BROKER_RISK_BASELINE"],
    ]);
    const next = reopened.append("SESSION_STARTED", { mode: "SIMULATION" }, 2001);
    assert.equal(next.sequence, 5);
  } finally {
    temp.cleanup();
  }
});
