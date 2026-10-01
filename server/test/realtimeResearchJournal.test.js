import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RealtimeResearchJournal,
  readRealtimeResearchEvents,
} from "../domain/realtimeResearchJournal.js";

test("연구 이벤트를 append-only JSONL로 기록하고 비밀정보를 제거한다", () => {
  const dir = mkdtempSync(join(tmpdir(), "pulse-research-"));
  const file = join(dir, "session.jsonl");
  let now = 1_000;
  const journal = new RealtimeResearchJournal(file, {
    now: () => now,
    sessionId: "session-1",
    eventIdFactory: (() => {
      let id = 0;
      return () => `event-${++id}`;
    })(),
    secrets: ["TOP-SECRET"],
    flushIntervalMs: 60_000,
  });
  journal.recordSessionStarted({
    appKey: "bad",
    note: "TOP-SECRET value",
    safe: true,
  });
  now = 1_100;
  journal.recordRealtimeMarketData({
    snapshot: { symbol: "005930", trade: { currentPrice: 70_000 } },
  });
  journal.flush();
  const text = readFileSync(file, "utf8");
  assert.doesNotMatch(text, /appKey|TOP-SECRET/);
  assert.match(text, /\[REDACTED\] value/);
  const events = readRealtimeResearchEvents(file);
  assert.equal(events.length, 2);
  assert.equal(events[0].sequence, 1);
  assert.equal(events[1].sequence, 2);
  assert.equal(journal.status().bytesWritten, Buffer.byteLength(text));
  journal.stop();
});

test("파일 크기 제한을 넘는 이벤트는 기록하지 않고 상태로 노출한다", () => {
  const dir = mkdtempSync(join(tmpdir(), "pulse-research-"));
  const journal = new RealtimeResearchJournal(join(dir, "session.jsonl"), {
    sessionId: "session-2",
    maxFileBytes: 300,
    flushIntervalMs: 60_000,
  });
  const first = journal.recordSessionStarted({ text: "x".repeat(50) });
  const second = journal.recordRealtimeMarketData({ text: "x".repeat(500) });
  assert.ok(first);
  assert.equal(second, null);
  assert.equal(journal.status().state, "LIMIT_REACHED");
  assert.equal(journal.status().droppedEvents, 1);
  journal.stop();
});

test("손상 JSON 또는 sequence 불일치를 거부한다", () => {
  const dir = mkdtempSync(join(tmpdir(), "pulse-research-"));
  const file = join(dir, "broken.jsonl");
  writeFileSync(file, '{"bad":true}\n', "utf8");
  assert.throws(
    () => readRealtimeResearchEvents(file),
    /형식이 올바르지 않습니다/,
  );
});
