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

test("신규상장 종목은 예비 점수가 올라가 병합 결과에서 우선순위가 높아진다", async () => {
  const newlyListed = new Map([
    ["069500", { symbol: "069500", name: "새내기전자", listingDate: "2026-09-10", daysSinceListing: 5 }],
  ]);
  const withoutBoost = mergeRankingRows({
    volumeRows: [row("005930", "삼성전자", "70000", "1.5", "1000000", "70000000000")],
    fluctuationRows: [],
    powerRows: [],
    limit: 10,
    fetchedAt: 1234,
  });
  const withBoost = mergeRankingRows({
    volumeRows: [row("005930", "삼성전자", "70000", "1.5", "1000000", "70000000000")],
    fluctuationRows: [row("069500", "새내기전자", "30000", "20.0", "500000", "10000000000")],
    powerRows: [],
    limit: 10,
    fetchedAt: 1234,
    newlyListed,
  });
  const samsung = withoutBoost.find((item) => item.symbol === "005930");
  const rookie = withBoost.find((item) => item.symbol === "069500");
  assert.equal(rookie.isNewlyListed, true);
  assert.equal(rookie.daysSinceListing, 5);
  assert.equal(rookie.listingDate, "2026-09-10");
  assert.equal(samsung.isNewlyListed, false);
  // 신규상장 부스트(+25)가 없으면 거래대금이 훨씬 큰 삼성전자보다 순위가 낮아야
  // 정상이라, 부스트가 실제로 순위를 뒤집는지 확인한다.
  assert.ok(rookie.preliminaryScore > samsung.preliminaryScore);
});

test("getRecentListings는 예탁원 공모주청약일정 응답에서 상장일 이내 종목만 반환한다", async () => {
  const fake = {
    config: { baseUrl: "https://example.test", appKey: "app", appSecret: "secret" },
    async getAccessToken() { return "token"; },
    async request(url) {
      assert.equal(url.pathname, "/uapi/domestic-stock/v1/ksdinfo/pub-offer");
      return response({
        rt_cd: "0",
        output1: [
          { sht_cd: "069500", isin_name: "새내기전자", list_dt: "2026/09/10" },
          { sht_cd: "005930", isin_name: "삼성전자", list_dt: "19750611" },
          { sht_cd: "999999", isin_name: "상장예정", list_dt: "2099/01/01" },
        ],
      });
    },
  };
  const client = new KisRecommendationDataClient({ client: fake, now: () => Date.parse("2026-09-24T00:00:00Z") });
  const listings = await client.getRecentListings({ windowDays: 20 });
  assert.equal(listings.size, 1);
  assert.deepEqual(listings.get("069500"), {
    symbol: "069500",
    name: "새내기전자",
    listingDate: "2026-09-10",
    daysSinceListing: 14,
  });
});

// 2026-10-01: "상장할 종목 리스트가 보여야지, 날짜도 보여야하고 미리 알 수
// 있어야지" 요청으로 추가 — getRecentListings()와 달리 상장 전(list_dt가
// 미래거나 아직 빈) 종목도 전부 보여주고, 청약기간·확정공모가·주관사를 그대로
// 돌려준다.
test("getPublicOfferingSchedule은 상장 전/후 가리지 않고 청약 일정을 전부 돌려주고 청약 시작일순으로 정렬한다", async () => {
  const fake = {
    config: { baseUrl: "https://example.test", appKey: "app", appSecret: "secret" },
    async getAccessToken() { return "token"; },
    async request(url) {
      assert.equal(url.pathname, "/uapi/domestic-stock/v1/ksdinfo/pub-offer");
      return response({
        rt_cd: "0",
        output1: [
          {
            sht_cd: "468670", isin_name: "브릴스", fix_subscr_pri: "       19500",
            subscr_dt: "2026/09/17 ~ 2026/09/18", list_dt: "2026/10/01", lead_mgr: "아이비케이투자증권",
          },
          {
            // 아직 공모가·상장일이 확정되지 않은 경우 — list_dt가 빈 문자열로 온다.
            sht_cd: "179880", isin_name: "멜콘", fix_subscr_pri: "       12300",
            subscr_dt: "2026/10/01 ~ 2026/10/02", list_dt: "", lead_mgr: "대신증권",
          },
        ],
      });
    },
  };
  const client = new KisRecommendationDataClient({ client: fake, now: () => Date.parse("2026-09-24T00:00:00Z") });
  const schedule = await client.getPublicOfferingSchedule();
  assert.equal(schedule.items.length, 2);
  // 청약 시작일이 이른 468670(09/17)이 179880(10/01)보다 먼저 와야 한다.
  assert.equal(schedule.items[0].symbol, "468670");
  assert.deepEqual(schedule.items[0], {
    symbol: "468670",
    name: "브릴스",
    fixedOfferPrice: 19500,
    subscriptionStart: "2026-09-17",
    subscriptionEnd: "2026-09-18",
    listingDate: "2026-10-01",
    leadManager: "아이비케이투자증권",
  });
  assert.equal(schedule.items[1].symbol, "179880");
  assert.equal(schedule.items[1].listingDate, null, "상장일 미확정은 null(화면에서 '미정')이어야 한다");
});

test("getPublicOfferingSchedule은 상장일 기준으로 거르고 정렬하며, 청약 기준일 조회 구간은 상장 지연만큼 앞으로 넓힌다", async () => {
  let requestedFrom;
  const fake = {
    config: { baseUrl: "https://example.test", appKey: "app", appSecret: "secret" },
    async getAccessToken() { return "token"; },
    async request(url) {
      requestedFrom = url.searchParams.get("F_DT");
      return response({
        rt_cd: "0",
        output1: [
          // 청약은 오래전이지만 상장은 곧 — 상장일 기준이라 보여야 한다.
          { sht_cd: "111110", isin_name: "곧상장", subscr_dt: "2026/09/01 ~ 2026/09/02", list_dt: "2026/10/08" },
          // 이미 상장한 지 10일이 넘었다 — 빠져야 한다.
          { sht_cd: "222220", isin_name: "오래전상장", subscr_dt: "2026/08/20 ~ 2026/08/21", list_dt: "2026/09/01" },
          // 상장일 미정 — 맨 뒤.
          { sht_cd: "333330", isin_name: "미정", subscr_dt: "2026/09/25 ~ 2026/09/26", list_dt: "" },
          { sht_cd: "444440", isin_name: "최근상장", subscr_dt: "2026/09/10 ~ 2026/09/11", list_dt: "2026/09/20" },
        ],
      });
    },
  };
  const client = new KisRecommendationDataClient({ client: fake, now: () => Date.parse("2026-09-24T00:00:00Z") });
  const schedule = await client.getPublicOfferingSchedule();
  assert.equal(requestedFrom, "20260815", "청약 기준일 조회는 오늘-(10+30)일부터여야 한다");
  assert.deepEqual(schedule.items.map((item) => item.symbol), ["444440", "111110", "333330"]);
});

test("getPublicOfferingSchedule은 영문이 섞인 신규 단축코드도 받고 tr_cont 연속조회로 다음 페이지까지 이어 받는다", async () => {
  const requestedContinuations = [];
  const pages = [
    {
      trCont: "M",
      rows: [{ sht_cd: "0088M0", isin_name: "영문코드", subscr_dt: "2026/10/05 ~ 2026/10/06", list_dt: "" }],
    },
    {
      trCont: "D",
      rows: [
        { sht_cd: "468670", isin_name: "브릴스", subscr_dt: "2026/09/17 ~ 2026/09/18", list_dt: "2026/10/01" },
        { sht_cd: "", isin_name: "코드없음", subscr_dt: "2026/10/07 ~ 2026/10/08", list_dt: "" },
      ],
    },
  ];
  const fake = {
    config: { baseUrl: "https://example.test", appKey: "app", appSecret: "secret" },
    async getAccessToken() { return "token"; },
    async request(_url, options) {
      requestedContinuations.push(options.headers.tr_cont ?? null);
      const page = pages[requestedContinuations.length - 1];
      return {
        ...response({ rt_cd: "0", output1: page.rows }),
        headers: { get: (name) => (name === "tr_cont" ? page.trCont : null) },
      };
    },
  };
  const client = new KisRecommendationDataClient({
    client: fake,
    now: () => Date.parse("2026-09-24T00:00:00Z"),
    minimumIntervalMs: 0,
  });
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  let schedule;
  try {
    schedule = await client.getPublicOfferingSchedule();
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(requestedContinuations, [null, "N"]);
  assert.deepEqual(schedule.items.map((item) => item.symbol), ["468670", "0088M0"]);
  assert.equal(warnings.length, 1, "형식 때문에 버린 행은 로그로 남겨야 한다");
  assert.match(warnings[0], /3건 중 1건/);
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
