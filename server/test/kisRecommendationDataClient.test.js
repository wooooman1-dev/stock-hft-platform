import test from "node:test";
import assert from "node:assert/strict";
import {
  filterCommonStockCandidates,
  KisRecommendationDataClient,
  mergeRankingRows,
} from "../integrations/kis/kisRecommendationDataClient.js";

test("거래대금·등락률·체결강도 순위를 병합하고 종목 마스터로 보통주만 남긴다", async () => {
  const merged = mergeRankingRows({
    volumeRows: [row("005930", "삼성전자", "70000", "1.5", "1000000", "70000000000")],
    fluctuationRows: [row("005930", "삼성전자", "70000", "1.5", "1000000", "70000000000"), row("000660", "SK하이닉스", "200000", "3.0", "500000", "100000000000")],
    powerRows: [
      { ...row("000660", "SK하이닉스", "200000", "3.0", "500000", "100000000000"), tday_rltv: "125.5" },
      row("069500", "KODEX 200", "30000", "1.0", "1000000", "30000000000"),
    ],
    limit: 10,
    fetchedAt: 1234,
  });
  assert.equal(merged.length, 3);

  const catalog = {
    async findBySymbol(symbol) {
      if (symbol === "069500") {
        return { symbol, market: "KOSPI", securityTypeCode: "EF", securityType: "ETF" };
      }
      return { symbol, market: "KOSPI", securityTypeCode: "ST", securityType: "주식" };
    },
  };
  const result = await filterCommonStockCandidates(merged, catalog, 10);
  assert.equal(result.length, 2);
  assert.equal(result.some((item) => item.symbol === "069500"), false);
  const hynix = result.find((item) => item.symbol === "000660");
  assert.equal(hynix.fluctuationRank, 2);
  assert.equal(hynix.volumePowerRank, 1);
  assert.equal(hynix.executionStrength, 125.5);
  assert.equal(hynix.securityType, "주식");
});

test("호가와 분봉 응답을 정규화한다", async () => {
  const requests = [];
  const fake = {
    config: { baseUrl: "https://example.test", appKey: "app", appSecret: "secret" },
    async getAccessToken() { return "token"; },
    async getCurrentPrice() {
      return { currentPrice: 10000, askUnit: 10, accumulatedTradingValue: 5_000_000_000 };
    },
    async request(url) {
      requests.push(url.pathname);
      if (url.pathname.endsWith("inquire-asking-price-exp-ccn")) {
        return response({ rt_cd: "0", output1: {
          askp1: "10010", bidp1: "10000", askp_rsqn1: "120", bidp_rsqn1: "180",
          total_askp_rsqn: "1200", total_bidp_rsqn: "1800",
        }, output2: {} });
      }
      if (url.pathname.endsWith("inquire-time-itemchartprice")) {
        return response({ rt_cd: "0", output1: {}, output2: [
          { stck_cntg_hour: "090000", stck_oprc: "10000", stck_hgpr: "10020", stck_lwpr: "9990", stck_prpr: "10010", cntg_vol: "100" },
        ] });
      }
      throw new Error(`unexpected ${url.pathname}`);
    },
  };
  const client = new KisRecommendationDataClient({ client: fake, now: () => 999 });
  const details = await client.getCandidateDetails({ symbol: "005930", market: "UN" });
  assert.equal(details.orderBook.bestAsk, 10010);
  assert.equal(details.orderBook.totalBidSize, 1800);
  assert.equal(details.minuteBars[0].close, 10010);
  assert.deepEqual(requests.sort(), [
    "/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn",
    "/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice",
  ].sort());
});

test("등락률 순위는 KIS가 요구하는 1자리 정렬 구분 코드를 전송한다", async () => {
  const fake = {
    config: { baseUrl: "https://example.test", appKey: "app", appSecret: "secret" },
    async getAccessToken() { return "token"; },
    async request(url) {
      if (url.pathname.endsWith("volume-rank")) {
        return response({ rt_cd: "0", output: [] });
      }
      if (url.pathname.endsWith("fluctuation")) {
        assert.equal(url.searchParams.get("fid_rank_sort_cls_code"), "0");
        assert.equal(url.searchParams.get("fid_rank_sort_cls_code")?.length, 1);
        return response({ rt_cd: "0", output: [] });
      }
      if (url.pathname.endsWith("volume-power")) {
        return response({ rt_cd: "0", output: [] });
      }
      throw new Error(`unexpected ${url.pathname}`);
    },
  };
  const client = new KisRecommendationDataClient({ client: fake, now: () => 999 });
  const result = await client.getUniverse({ limit: 10 });
  assert.deepEqual(result, []);
});

test("KIS 순위 HTTP 실패도 상태 코드와 공급자 메시지를 노출하되 비밀값은 제거한다", async () => {
  const fake = {
    config: {
      baseUrl: "https://example.test",
      appKey: "APP-KEY-SECRET",
      appSecret: "APP-SECRET",
    },
    async getAccessToken() { return "ACCESS-TOKEN"; },
    async request(url) {
      if (url.pathname.endsWith("volume-rank")) {
        return response({ rt_cd: "0", output: [] });
      }
      if (url.pathname.endsWith("fluctuation")) {
        return response({
          rt_cd: "1",
          msg_cd: "EGW-HTTP-CODE",
          msg1: "호출 제한 APP-KEY-SECRET APP-SECRET ACCESS-TOKEN",
        }, 500);
      }
      throw new Error(`unexpected ${url.pathname}`);
    },
  };
  const client = new KisRecommendationDataClient({ client: fake, now: () => 999 });
  await assert.rejects(
    client.getUniverse({ limit: 10 }),
    (error) => {
      assert.equal(error.code, "KIS_RECOMMENDATION_HTTP_ERROR");
      assert.equal(error.statusCode, 500);
      assert.match(error.message, /HTTP 500/);
      assert.match(error.message, /EGW-HTTP-CODE/);
      assert.match(error.message, /호출 제한/);
      assert.doesNotMatch(error.message, /APP-SECRET|ACCESS-TOKEN|APP-KEY-SECRET/);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
});

test("KIS 순위 거절 응답은 공급자 코드와 메시지를 노출하되 비밀값은 제거한다", async () => {
  const fake = {
    config: {
      baseUrl: "https://example.test",
      appKey: "APP-KEY-SECRET",
      appSecret: "APP-SECRET",
    },
    async getAccessToken() { return "ACCESS-TOKEN"; },
    async request(url) {
      if (url.pathname.endsWith("volume-rank")) {
        return response({ rt_cd: "0", output: [] });
      }
      if (url.pathname.endsWith("fluctuation")) {
        return response({
          rt_cd: "1",
          msg_cd: "PROVIDER-CODE",
          msg1: "시장 상태 오류 APP-SECRET ACCESS-TOKEN",
        });
      }
      throw new Error(`unexpected ${url.pathname}`);
    },
  };
  const client = new KisRecommendationDataClient({ client: fake, now: () => 999 });
  await assert.rejects(
    client.getUniverse({ limit: 10 }),
    (error) => {
      assert.equal(error.code, "KIS_RECOMMENDATION_REJECTED");
      assert.match(error.message, /PROVIDER-CODE/);
      assert.match(error.message, /시장 상태 오류/);
      assert.doesNotMatch(error.message, /APP-SECRET|ACCESS-TOKEN|APP-KEY-SECRET/);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
});


test("조회 전용 순위 API는 EGW00201만 제한된 횟수로 대기 후 재시도한다", async () => {
  let fluctuationCalls = 0;
  const waits = [];
  let now = 0;
  const fake = {
    config: { baseUrl: "https://example.test", appKey: "app", appSecret: "secret" },
    async getAccessToken() { return "token"; },
    async request(url) {
      if (url.pathname.endsWith("volume-rank")) return response({ rt_cd: "0", output: [] });
      if (url.pathname.endsWith("fluctuation")) {
        fluctuationCalls += 1;
        if (fluctuationCalls === 1) {
          return response({ rt_cd: "1", msg_cd: "EGW00201", msg1: "초당 거래건수를 초과하였습니다." }, 500);
        }
        return response({ rt_cd: "0", output: [] });
      }
      if (url.pathname.endsWith("volume-power")) return response({ rt_cd: "0", output: [] });
      throw new Error(`unexpected ${url.pathname}`);
    },
  };
  const client = new KisRecommendationDataClient({
    client: fake,
    now: () => now,
    minimumIntervalMs: 1000,
    rateLimitRetryCount: 2,
    rateLimitRetryBaseMs: 1200,
    sleep: async (ms) => { waits.push(ms); now += ms; },
  });
  const result = await client.getUniverse({ limit: 10 });
  assert.deepEqual(result, []);
  assert.equal(fluctuationCalls, 2);
  assert.ok(waits.includes(1200));
  assert.equal(client.status().minimumIntervalMs, 1000);
});

function row(symbol, name, price, change, volume, value) {
  return {
    mksc_shrn_iscd: symbol,
    hts_kor_isnm: name,
    stck_prpr: price,
    prdy_ctrt: change,
    acml_vol: volume,
    acml_tr_pbmn: value,
  };
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

// 2026-09-10 확인: "UN"(KRX+NXT 통합)으로 분봉을 조회하면 NXT 미상장 종목이
// 30행 전부 O=H=L=C=V=0인 빈 응답으로 돌아온다. 분봉은 항상 "J"로 조회해야 한다.
test("당일 분봉은 market 인자와 무관하게 항상 J로 조회한다", async () => {
  const urls = [];
  const fake = {
    config: { baseUrl: "https://example.test", appKey: "app", appSecret: "secret" },
    async getAccessToken() { return "token"; },
    async request(url) {
      urls.push(url);
      return response({ rt_cd: "0", output1: {}, output2: [] });
    },
  };
  const client = new KisRecommendationDataClient({ client: fake, now: () => 999 });

  await client.getMinuteBars({ symbol: "036930", market: "UN", hour: "095500" });
  await client.getMinuteBars({ symbol: "005930", market: "NX", hour: "095500" });

  assert.equal(urls.length, 2);
  for (const url of urls) {
    assert.equal(
      url.searchParams.get("FID_COND_MRKT_DIV_CODE"),
      "J",
      `분봉 조회는 J여야 한다 (받은 값: ${url.searchParams.get("FID_COND_MRKT_DIV_CODE")})`,
    );
  }
});

// 2026-09-10 확인: cttr(체결강도)와 vol_tnrt(거래량회전율)를 한 필드로 묶어 읽어
// 거래량순위에서 온 종목은 회전율이 체결강도 자리에 들어갔다(삼성전자 0.06 등).
test("거래량회전율을 체결강도로 읽지 않는다", () => {
  const merged = mergeRankingRows({
    volumeRows: [{
      ...row("005930", "삼성전자", "265250", "-1.58", "7166481", "1919895699500"),
      vol_tnrt: "0.06",
    }],
    fluctuationRows: [],
    powerRows: [],
    limit: 10,
    fetchedAt: 1234,
  });
  const samsung = merged.find((item) => item.symbol === "005930");
  assert.equal(samsung.executionStrength, null, "회전율만 있으면 체결강도는 비어야 한다");
  assert.equal(samsung.volumeTurnoverRate, 0.06, "회전율은 별도 필드로 보존해야 한다");
});

test("체결강도는 cttr에서 읽는다", () => {
  const merged = mergeRankingRows({
    volumeRows: [{
      ...row("000660", "SK하이닉스", "200000", "3.0", "500000", "100000000000"),
      cttr: "142.7",
      vol_tnrt: "1.9",
    }],
    fluctuationRows: [],
    powerRows: [],
    limit: 10,
    fetchedAt: 1234,
  });
  const hynix = merged.find((item) => item.symbol === "000660");
  assert.equal(hynix.executionStrength, 142.7);
  assert.equal(hynix.volumeTurnoverRate, 1.9);
});
