const DEFAULT_BASE_URL = "https://openapi.ls-sec.co.kr:8080";
const EXPIRY_SKEW_MS = 60_000;

export class LsAuthClient {
  constructor({
    appKey,
    appSecret,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    now = Date.now,
  }) {
    this.appKey = appKey;
    this.appSecret = appSecret;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.cachedToken = null;
    this.expiresAt = 0;
    this.pendingRequest = null;
  }

  async getAccessToken({ forceRefresh = false } = {}) {
    this.validateCredentials();
    if (!forceRefresh && this.cachedToken && this.now() < this.expiresAt - EXPIRY_SKEW_MS) {
      return this.cachedToken;
    }
    if (!forceRefresh && this.pendingRequest) return this.pendingRequest;
    this.pendingRequest = this.requestToken();
    try {
      return await this.pendingRequest;
    } finally {
      this.pendingRequest = null;
    }
  }

  validateCredentials() {
    if (!this.appKey || !this.appSecret) {
      throw new Error("LS_APP_KEY와 LS_APP_SECRET을 .env에 설정해야 합니다.");
    }
    if (typeof this.fetchImpl !== "function") throw new Error("fetch 구현이 필요합니다.");
  }

  async requestToken() {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      appkey: this.appKey,
      appsecretkey: this.appSecret,
      scope: "oob",
    });
    const tokenUrl = new URL(`${this.baseUrl}/oauth2/token`);
    tokenUrl.search = body.toString();
    const response = await this.fetchImpl(tokenUrl.toString(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(payload.rsp_msg ?? payload.error_description ?? `LS 접근토큰 발급 실패 (${response.status})`);
    }
    if (!payload.access_token) throw new Error("LS 접근토큰 응답에 access_token이 없습니다.");
    const expiresInSeconds = Number(payload.expires_in);
    const lifetimeMs = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
      ? expiresInSeconds * 1_000
      : 23 * 60 * 60 * 1_000;
    this.cachedToken = payload.access_token;
    this.expiresAt = this.now() + lifetimeMs;
    return this.cachedToken;
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { throw new Error(`LS API가 JSON이 아닌 응답을 반환했습니다. (${response.status})`); }
}
