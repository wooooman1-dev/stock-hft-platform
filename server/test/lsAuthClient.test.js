import assert from "node:assert/strict";
import test from "node:test";
import { LsAuthClient } from "../brokers/ls/lsAuthClient.js";

test("LS auth requests and caches an OAuth access token", async () => {
  const requests = [];
  let now = 1_000_000;
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ access_token: "token-1", expires_in: 3600 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new LsAuthClient({
    appKey: "app-key",
    appSecret: "app-secret",
    fetchImpl,
    now: () => now,
  });

  assert.equal(await client.getAccessToken(), "token-1");
  assert.equal(await client.getAccessToken(), "token-1");
  assert.equal(requests.length, 1);
  const tokenUrl = new URL(requests[0].url);
  assert.equal(`${tokenUrl.origin}${tokenUrl.pathname}`, "https://openapi.ls-sec.co.kr:8080/oauth2/token");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers["content-type"], "application/x-www-form-urlencoded");
  assert.deepEqual(Object.fromEntries(tokenUrl.searchParams), {
    grant_type: "client_credentials",
    appkey: "app-key",
    appsecretkey: "app-secret",
    scope: "oob",
  });

  now += 3_600_000;
  await client.getAccessToken();
  assert.equal(requests.length, 2);
});

test("LS auth rejects missing credentials before sending a request", async () => {
  const client = new LsAuthClient({ appKey: "", appSecret: "" });
  await assert.rejects(() => client.getAccessToken(), /LS_APP_KEY/);
});
