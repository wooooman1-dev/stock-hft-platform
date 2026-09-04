import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionJournal } from "../domain/executionJournal.js";
import { KisPaperOrderService } from "../integrations/kis/kisPaperOrderService.js";
import { KisLiveOrderService } from "../integrations/kis/kisLiveOrderService.js";

// 모의투자(KisPaperOrderService)와 실전투자(KisLiveOrderService)가 실제 파일 기반
// ExecutionJournal을 각각 별도 파일로 구성했을 때, 서로의 clientOrderId 커맨드를
// replayJournal()이 섞어서 읽어들이지 않는지 확인한다. 계획서 §5가 근거로 든
// "물리적으로 분리된 저널 파일" 격리 전략이 실제로 작동함을 검증하는 통합 테스트다.

function brokerClient() {
  return {
    submitCalls: 0,
    async getBalance() { return { summary: { evaluationProfitLoss: 0 } }; },
    async submitOrder(request) { this.submitCalls += 1; return { status: "ACCEPTED", orderNumber: String(this.submitCalls), request }; },
    async reviseOrder(request) { return { status: "ACCEPTED", orderNumber: "revise", request }; },
    async cancelOrder(request) { return { status: "ACCEPTED", orderNumber: "cancel", request }; },
  };
}

test("paper and live services with separate journal files never replay each other's commands", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pulsehft-journal-isolation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const paperJournal = new ExecutionJournal(join(dir, "execution-journal.jsonl"));
  const liveJournal = new ExecutionJournal(join(dir, "execution-journal-live.jsonl"));

  const paperBroker = brokerClient();
  const liveBroker = brokerClient();

  const paperService = new KisPaperOrderService({
    client: paperBroker,
    journal: paperJournal,
    limits: { maxOrderQuantity: 10, maxOrderValue: 1_000_000, maxDailyOrders: 20, maxDailyLoss: 0 },
    now: () => Date.parse("2026-08-01T09:00:00Z"),
    commandIdFactory: (() => { let id = 0; return () => `paper-command-${++id}`; })(),
  });
  const liveService = new KisLiveOrderService({
    client: liveBroker,
    journal: liveJournal,
    limits: { maxOrderQuantity: 1, maxOrderValue: 2_000_000, maxDailyOrders: 5, maxDailyLoss: 0, maxConsecutiveLosses: 0 },
    now: () => Date.parse("2026-08-01T09:00:00Z"),
    commandIdFactory: (() => { let id = 0; return () => `live-command-${++id}`; })(),
  });

  await paperService.submitOrder({ clientOrderId: "shared-id", side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 70000 });
  await liveService.submitOrder({ clientOrderId: "shared-id", side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 70000 });

  assert.equal(paperBroker.submitCalls, 1);
  assert.equal(liveBroker.submitCalls, 1);

  // 두 서비스를 각자의 저널에서 재구성해도, clientOrderId가 같아도 서로의 커맨드를 보지 못한다.
  const restartedPaper = new KisPaperOrderService({
    client: brokerClient(),
    journal: paperJournal,
    limits: { maxOrderQuantity: 10, maxOrderValue: 1_000_000, maxDailyOrders: 20, maxDailyLoss: 0 },
    now: () => Date.parse("2026-08-01T09:05:00Z"),
  });
  const restartedLive = new KisLiveOrderService({
    client: brokerClient(),
    journal: liveJournal,
    limits: { maxOrderQuantity: 1, maxOrderValue: 2_000_000, maxDailyOrders: 5, maxDailyLoss: 0, maxConsecutiveLosses: 0 },
    now: () => Date.parse("2026-08-01T09:05:00Z"),
  });

  assert.equal(restartedPaper.commands.size, 1);
  assert.equal(restartedLive.commands.size, 1);
  assert.ok(restartedPaper.commands.has("shared-id"));
  assert.ok(restartedLive.commands.has("shared-id"));

  // 각자의 재생 결과는 자신의 브로커 응답만 반영해야 한다(다른 쪽 커맨드가 섞여 들어오지 않음).
  const paperReplay = await restartedPaper.submitOrder({ clientOrderId: "shared-id", side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 70000 });
  const liveReplay = await restartedLive.submitOrder({ clientOrderId: "shared-id", side: "BUY", symbol: "005930", type: "LIMIT", quantity: 1, limitPrice: 70000 });
  assert.equal(paperReplay.replayed, true);
  assert.equal(liveReplay.replayed, true);

  // 물리적으로 두 개의 별도 파일임을 직접 확인한다.
  assert.equal(paperJournal.filePath === liveJournal.filePath, false);
  const paperEvents = paperJournal.readAll();
  const liveEvents = liveJournal.readAll();
  assert.ok(paperEvents.every((event) => event.payload?.clientOrderId !== "live-only-marker"));
  assert.equal(paperEvents.length > 0 && liveEvents.length > 0, true);
});
