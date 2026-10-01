import test from "node:test";
import assert from "node:assert/strict";
import {
  NaverApiHubClient,
  createNaverApiHubClientFromEnv,
} from "../integrations/naver/naverApiHubClient.js";

test("NAVER API HUB 뉴스와 카페 검색을 정규화하고 캐시한다", async () => {
  const requests = [];
  const client = new NaverApiHubClient({
    clientId: "client-id",
    clientSecret: "client-secret",
    now: () => 1000,
    fetchImpl: async (url, options) => {
      requests.push({ path: url.pathname, headers: options.headers });
      if (url.pathname.endsWith("/news")) {
        return response({ total: 12, items: [{ title: "<b>삼성전자</b> 뉴스", description: "설명", link: "https://example.test/news", pubDate: "Fri, 01 Aug 2026 10:00:00 +0900" }] });
      }
      return response({ total: 4, items: [{ title: "<b>삼성전자</b> 게시글", description: "카페 설명", link: "https://cafe.naver.com/example/1", postdate: "20260801", cafename: "주식카페" }] });
    },
  });
  const first = await client.getSignals({ symbol: "005930", name: "삼성전자" });
  assert.equal(first.news.items[0].title, "삼성전자 뉴스");
  assert.equal(first.community.items[0].sourceName, "주식카페");
  assert.equal(requests[0].headers["X-NCP-APIGW-API-KEY-ID"], "client-id");
  await client.getSignals({ symbol: "005930", name: "삼성전자" });
  assert.equal(requests.length, 2, "동일 검색어는 캐시돼야 한다");
});

test("NAVER API HUB 키는 둘 다 설정해야 한다", () => {
  assert.equal(createNaverApiHubClientFromEnv({}), null);
  assert.throws(() => createNaverApiHubClientFromEnv({ PULSEHFT_NAVER_API_HUB_CLIENT_ID: "id" }));
});

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}
