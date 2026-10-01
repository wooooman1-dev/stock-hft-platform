import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexSource = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
const source = readFileSync(new URL("../../public/kisReconciliation.js", import.meta.url), "utf8");

test("dashboard loads the KIS reconciliation status adapter", () => {
  assert.match(indexSource, /kisReconciliation\.js\?v=2/);
  assert.match(source, /\/api\/kis\/paper\/status/);
  assert.match(source, /KIS ACCOUNT RECONCILIATION/);
});

test("reconciliation UI explains mismatch blocking and acknowledgement through the kill switch", () => {
  assert.match(source, /계좌 불일치 감지/);
  assert.match(source, /신규·정정 주문이 차단/);
  assert.match(source, /취소 주문만 허용/);
  assert.match(source, /킬 스위치를 끄면 대조 확인/);
  assert.match(source, /RESOLVED_AWAITING_ACK/);
});

test("reconciliation UI names the unknown result commands and the resolution command", () => {
  assert.match(source, /unknownCommands/);
  assert.match(source, /주문 결과 불명/);
  assert.match(source, /npm run resolve:kis:paper-unknown/);
});
