import test from "node:test";
import assert from "node:assert/strict";
import { KisRecommendationResearchDataClient } from "../integrations/kis/kisRecommendationResearchDataClient.js";

test("원본 순위 응답과 필터링된 후보를 함께 보존한다", async () => {
  const fake = {
    config: {
      baseUrl: "https://example.test",
      appKey: "app",
      appSecret: "secret",
    },
    async getAccessToken() { return "token"; },
    async request(url) {
      if (url.pathname.endsWith("volume-rank")) {
        return response({ rt_cd: "0", output: [row("005930", "삼성전자")] });
      }
      if (url.pathname.endsWith("fluctuation")) {
        return response({ rt_cd: "0", output: [row("000660", "SK하이닉스")] });
      }
      if (url.pathname.endsWith("volume-power")) {
        return response({
          rt_cd: "0",
          output: [{ ...row("005930", "삼성전자"), tday_rltv: "125" }],
        });
      }
      throw new Error(`unexpected ${url.pathname}`);
    },
  };
  const client = new KisRecommendationResearchDataClient({
    client: fake,
    now: () => 1_234,
    minimumIntervalMs: 0,
    sleep: async () => {},
  });
  const snapshot = await client.getUniverseSnapshot({ limit: 10 });
  assert.equal(snapshot.fetchedAt, 1_234);
  assert.equal(snapshot.rankings.volume.length, 1);
  assert.equal(snapshot.rankings.fluctuation.length, 1);
  assert.equal(snapshot.rankings.volumePower.length, 1);
  assert.equal(snapshot.candidates.length, 2);
  assert.equal(snapshot.candidates[0].fetchedAt, 1_234);
  assert.equal(client.status().rawRankingSnapshotAvailable, true);
});

// 2026-10-01: getUniverseSnapshot()가 이 하위 클래스에서 override돼 있어, 부모
// 클래스(KisRecommendationDataClient)에만 신규상장 조회(getRecentListings) 호출이
// 추가되고 여기엔 안 들어가면 실제 운영 경로(app.js가 이 클래스를 생성한다)에서는
// isNewlyListed가 항상 false로 조용히 남는다 — "신규 배지가 안 보인다"는 실측 보고로
// 확인된 회귀를 재발 방지한다.
test("getUniverseSnapshot도 신규상장 종목을 조회해 isNewlyListed를 채운다", async () => {
  const fake = {
    config: { baseUrl: "https://example.test", appKey: "app", appSecret: "secret" },
    async getAccessToken() { return "token"; },
    async request(url) {
      if (url.pathname.endsWith("volume-rank")) {
        return response({ rt_cd: "0", output: [row("005930", "삼성전자")] });
      }
      if (url.pathname.endsWith("fluctuation")) {
        return response({ rt_cd: "0", output: [row("069500", "새내기전자")] });
      }
      if (url.pathname.endsWith("volume-power")) {
        return response({ rt_cd: "0", output: [] });
      }
      if (url.pathname.endsWith("pub-offer")) {
        return response({
          rt_cd: "0",
          output1: [{ sht_cd: "069500", isin_name: "새내기전자", list_dt: "2026/09/10" }],
        });
      }
      throw new Error(`unexpected ${url.pathname}`);
    },
  };
  const client = new KisRecommendationResearchDataClient({
    client: fake,
    now: () => Date.parse("2026-09-24T00:00:00Z"),
    minimumIntervalMs: 0,
    sleep: async () => {},
  });
  const snapshot = await client.getUniverseSnapshot({ limit: 10, newlyListedWindowDays: 20 });
  const rookie = snapshot.candidates.find((item) => item.symbol === "069500");
  assert.equal(rookie.isNewlyListed, true);
  assert.equal(rookie.daysSinceListing, 14);
});

function row(symbol, name) {
  return {
    mksc_shrn_iscd: symbol,
    hts_kor_isnm: name,
    stck_prpr: "70000",
    prdy_ctrt: "1.5",
    acml_vol: "1000000",
    acml_tr_pbmn: "70000000000",
  };
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}
