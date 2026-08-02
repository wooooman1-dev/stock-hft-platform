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
