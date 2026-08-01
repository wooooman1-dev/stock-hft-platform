import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const KIS_TOKEN_SCHEMA_VERSION = 1;

export class KisTokenStoreError extends Error {
  constructor(message, code = "KIS_TOKEN_STORE_ERROR") {
    super(message);
    this.name = "KisTokenStoreError";
    this.code = code;
    this.statusCode = 500;
  }
}

export class KisTokenStore {
  constructor(filePath, { now = Date.now, safetyWindowMs = 60_000 } = {}) {
    if (!filePath) throw new TypeError("한국투자 토큰 파일 경로가 필요합니다.");
    if (typeof now !== "function") throw new TypeError("now는 함수여야 합니다.");
    if (!Number.isFinite(safetyWindowMs) || safetyWindowMs < 0) {
      throw new TypeError("safetyWindowMs는 0 이상의 유한한 숫자여야 합니다.");
    }
    this.filePath = filePath;
    this.now = now;
    this.safetyWindowMs = safetyWindowMs;
  }

  load() {
    if (!existsSync(this.filePath)) return null;
    let payload;
    try {
      payload = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new KisTokenStoreError(
        `한국투자 토큰 파일을 읽을 수 없습니다: ${formatError(error)}`,
        "KIS_TOKEN_READ_FAILED",
      );
    }
    validateToken(payload);
    return structuredClone(payload);
  }

  loadValid() {
    const token = this.load();
    if (!token) return null;
    if (token.expiresAt <= this.now() + this.safetyWindowMs) return null;
    return token;
  }

  save({ accessToken, tokenType = "Bearer", expiresAt, issuedAt = this.now() }) {
    const payload = {
      schemaVersion: KIS_TOKEN_SCHEMA_VERSION,
      accessToken,
      tokenType,
      issuedAt: Number(issuedAt),
      expiresAt: Number(expiresAt),
    };
    validateToken(payload);

    const directory = dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    mkdirSync(directory, { recursive: true });
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporaryPath, this.filePath);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw new KisTokenStoreError(
        `한국투자 토큰을 저장할 수 없습니다: ${formatError(error)}`,
        "KIS_TOKEN_WRITE_FAILED",
      );
    }
    return structuredClone(payload);
  }

  status() {
    const token = this.load();
    if (!token) return { state: "MISSING", expiresAt: null };
    const valid = token.expiresAt > this.now() + this.safetyWindowMs;
    return {
      state: valid ? "VALID" : "EXPIRED",
      expiresAt: token.expiresAt,
    };
  }
}

function validateToken(payload) {
  if (!isRecord(payload)) throw invalidToken("JSON 객체가 아닙니다.");
  const allowed = new Set(["schemaVersion", "accessToken", "tokenType", "issuedAt", "expiresAt"]);
  const unknown = Object.keys(payload).filter((field) => !allowed.has(field));
  if (unknown.length > 0) throw invalidToken(`허용되지 않은 필드가 있습니다: ${unknown.join(", ")}`);
  if (payload.schemaVersion !== KIS_TOKEN_SCHEMA_VERSION) {
    throw invalidToken(`지원하지 않는 schemaVersion ${String(payload.schemaVersion)}입니다.`);
  }
  if (typeof payload.accessToken !== "string" || payload.accessToken.length === 0) {
    throw invalidToken("accessToken이 없습니다.");
  }
  if (typeof payload.tokenType !== "string" || payload.tokenType.length === 0) {
    throw invalidToken("tokenType이 없습니다.");
  }
  if (!Number.isFinite(payload.issuedAt)) throw invalidToken("issuedAt이 유효하지 않습니다.");
  if (!Number.isFinite(payload.expiresAt) || payload.expiresAt <= payload.issuedAt) {
    throw invalidToken("expiresAt이 issuedAt보다 커야 합니다.");
  }
}

function invalidToken(detail) {
  return new KisTokenStoreError(
    `한국투자 토큰 파일 형식이 올바르지 않습니다: ${detail}`,
    "KIS_TOKEN_READ_FAILED",
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
