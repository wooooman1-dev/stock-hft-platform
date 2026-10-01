import test from "node:test";
import assert from "node:assert/strict";
import {
  OpenDartClient,
  classifyDisclosureRisk,
  createOpenDartClientFromEnv,
} from "../integrations/opendart/openDartClient.js";

test("OpenDART 최근 공시를 종목코드별로 묶고 위험 공시를 표시한다", async () => {
  let calls = 0;
  const client = new OpenDartClient({
    apiKey: "a".repeat(40),
    now: () => Date.parse("2026-08-01T12:00:00+09:00"),
    fetchImpl: async (url) => {
      calls += 1;
      assert.equal(url.pathname, "/api/list.json");
      assert.equal(url.searchParams.get("page_count"), "100");
      return response({
        status: "000",
        total_page: 1,
        list: [
          { stock_code: "005930", corp_name: "삼성전자", report_nm: "주요사항보고서(유상증자결정)", rcept_no: "1", rcept_dt: "20260801" },
          { stock_code: "000660", corp_name: "SK하이닉스", report_nm: "기업설명회(IR)개최", rcept_no: "2", rcept_dt: "20260801" },
        ],
      });
    },
  });
  const first = await client.getRecentDisclosures({ stockCodes: ["005930", "000660"] });
  assert.equal(first.get("005930").riskLevel, "HIGH");
  assert.equal(first.get("000660").riskLevel, "NONE");
  assert.equal(first.get("005930").count, 1);
  await client.getRecentDisclosures({ stockCodes: ["005930"] });
  assert.equal(calls, 1, "캐시 안에서는 추가 호출하지 않아야 한다");
});

test("OpenDART 키가 없으면 선택적 클라이언트를 만들지 않는다", () => {
  assert.equal(createOpenDartClientFromEnv({}), null);
  assert.equal(classifyDisclosureRisk([{ reportName: "전환사채 발행결정" }]).level, "HIGH");
});

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}
