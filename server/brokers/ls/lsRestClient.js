import { normalizeT1101Response } from "./lsProtocol.js";

const DEFAULT_BASE_URL = "https://openapi.ls-sec.co.kr:8080";

export class LsRestClient {
  constructor({ authClient, baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch, now = Date.now }) {
    if (!authClient) throw new Error("LsRestClient에는 authClient가 필요합니다.");
    this.authClient = authClient;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async postTr({ path, trCode, body, continuation = "N", continuationKey = "" }) {
    const token = await this.authClient.getAccessToken();
    const response = await this.fetchImpl(`${this.baseUrl}/${path.replace(/^\//, "")}`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
        tr_cd: trCode,
        tr_cont: continuation,
        tr_cont_key: continuationKey,
      },
      body: JSON.stringify(body),
    });
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(payload.rsp_msg ?? payload.message ?? `LS REST 요청 실패 (${response.status})`);
    }
    return payload;
  }

  async getCurrentOrderBook(symbol) {
    if (!/^\d{6}$/.test(String(symbol))) throw new Error("LS 국내주식 종목코드는 6자리 숫자여야 합니다.");
    const response = await this.postTr({
      path: "/stock/market-data",
      trCode: "t1101",
      body: { t1101InBlock: { shcode: String(symbol) } },
    });
    return normalizeT1101Response(response, this.now());
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { throw new Error(`LS API가 JSON이 아닌 응답을 반환했습니다. (${response.status})`); }
}
