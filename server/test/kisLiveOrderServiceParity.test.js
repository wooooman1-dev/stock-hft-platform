import assert from "node:assert/strict";
import test from "node:test";
import { KisPaperOrderService } from "../integrations/kis/kisPaperOrderService.js";
import { KisLiveOrderService } from "../integrations/kis/kisLiveOrderService.js";

// KisLiveOrderService는 KisPaperOrderService를 의도적으로 복제(재사용이 아님, 계획서 §4 근거:
// KIS_PAPER_* 코드와 "모의" 문구가 거의 모든 분기에 하드코딩돼 있어 매개변수화가 더 위험함)한
// 파일이다. 복제는 두 파일이 시간이 지나며 조용히 갈라질 위험이 있으므로, 이 테스트는 두 서비스가
// 같은 공개 메서드 집합과 같은 순서의 안전검사를 갖고 있는지 구조적으로 확인해 향후 리팩터링이
// 실수로 한쪽에서만 안전검사를 빠뜨리면 CI가 즉시 잡아내게 한다.

const PUBLIC_METHODS = [
  "status",
  "setKillSwitch",
  "getBalance",
  "submitOrder",
  "reviseOrder",
  "cancelOrder",
  "enqueue",
  "execute",
  "enforceSafety",
  "refreshReconciliation",
  "performReconciliation",
  "getPerformance",
  "getFillComparison",
  "unknownCommands",
  "resolveUnknownResult",
  "executeUnknownResolution",
  "loadUnknownResolutionEvidence",
  "enterUnknownResult",
  "appendOrThrow",
  "replayJournal",
  "markInterruptedCommandsUnknown",
];

// enforceSafety가 순서대로 실행하는 안전검사. 코드 접두사(KIS_PAPER_/KIS_LIVE_)를 뺀 나머지가
// 두 서비스에서 동일한 순서로 나타나야 한다. KIS_LIVE_CANARY_QUANTITY_LIMIT은 카나리 전용 추가
// 검사이므로 의도적으로 페어링에서 제외한다.
const SAFETY_CHECK_ORDER = [
  "KILL_SWITCH",
  "ORDER_QUANTITY_LIMIT",
  "REFERENCE_PRICE_REQUIRED",
  "ORDER_VALUE_LIMIT",
  "DAILY_ORDER_LIMIT",
  "DAILY_LOSS_LIMIT",
  "CONSECUTIVE_LOSS_LIMIT",
];

function methodNamesAndArities(SomeClass) {
  return PUBLIC_METHODS.map((name) => {
    const fn = SomeClass.prototype[name];
    assert.ok(typeof fn === "function", `${SomeClass.name}.${name} must exist`);
    return { name, length: fn.length };
  });
}

test("KisPaperOrderService and KisLiveOrderService expose the same public method names and arities", () => {
  const paperMethods = methodNamesAndArities(KisPaperOrderService);
  const liveMethods = methodNamesAndArities(KisLiveOrderService);
  assert.deepEqual(liveMethods, paperMethods);
});

test("both services declare the safety limit error codes in the same order inside enforceSafety", async () => {
  const paperSource = KisPaperOrderService.prototype.enforceSafety.toString();
  const liveSource = KisLiveOrderService.prototype.enforceSafety.toString();

  const paperOrder = SAFETY_CHECK_ORDER
    .map((suffix) => ({ suffix, index: paperSource.indexOf(`KIS_PAPER_${suffix}`) }))
    .filter((entry) => entry.index >= 0)
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.suffix);
  const liveOrder = SAFETY_CHECK_ORDER
    .map((suffix) => ({ suffix, index: liveSource.indexOf(`KIS_LIVE_${suffix}`) }))
    .filter((entry) => entry.index >= 0)
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.suffix);

  assert.deepEqual(paperOrder, SAFETY_CHECK_ORDER);
  assert.deepEqual(liveOrder, SAFETY_CHECK_ORDER);
});

test("both services always allow CANCEL to bypass safety checks", () => {
  for (const SomeClass of [KisPaperOrderService, KisLiveOrderService]) {
    const source = SomeClass.prototype.enforceSafety.toString();
    assert.match(source, /operation === "CANCEL"\)\s*return/);
  }
});
