import { existsSync, readFileSync } from "node:fs";

export const KIS_MODE_DISABLED = "DISABLED";
export const KIS_MODE_PROD_READ_ONLY = "PROD_READ_ONLY";
export const KIS_PROD_BASE_URL = "https://openapi.koreainvestment.com:9443";

const ALLOWED_CREDENTIAL_FIELDS = new Set(["appKey", "appSecret"]);

export class KisConfigurationError extends Error {
  constructor(message, code = "KIS_CONFIGURATION_ERROR") {
    super(message);
    this.name = "KisConfigurationError";
    this.code = code;
    this.statusCode = 503;
  }
}

export function loadKisConfiguration(filePath, { env = process.env } = {}) {
  const mode = String(env.PULSEHFT_KIS_MODE ?? KIS_MODE_DISABLED).trim().toUpperCase();
  if (mode === KIS_MODE_DISABLED) {
    return Object.freeze({
      enabled: false,
      configured: false,
      mode: KIS_MODE_DISABLED,
      environment: null,
      baseUrl: null,
      credentialsPath: filePath,
    });
  }

  if (mode !== KIS_MODE_PROD_READ_ONLY) {
    throw new KisConfigurationError(
      `지원하지 않는 한국투자 연동 모드입니다: ${mode}`,
      "KIS_UNSUPPORTED_MODE",
    );
  }

  if (!filePath || !existsSync(filePath)) {
    throw new KisConfigurationError(
      "한국투자 실전 시세 전용 자격정보 파일이 없습니다.",
      "KIS_CREDENTIALS_MISSING",
    );
  }

  let payload;
  try {
    payload = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new KisConfigurationError(
      `한국투자 자격정보 파일을 읽을 수 없습니다: ${formatError(error)}`,
      "KIS_CREDENTIALS_READ_FAILED",
    );
  }

  if (!isRecord(payload)) {
    throw new KisConfigurationError(
      "한국투자 자격정보 파일은 JSON 객체여야 합니다.",
      "KIS_CREDENTIALS_INVALID",
    );
  }

  const unknownFields = Object.keys(payload).filter((field) => !ALLOWED_CREDENTIAL_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw new KisConfigurationError(
      `한국투자 자격정보 파일에 허용되지 않은 필드가 있습니다: ${unknownFields.join(", ")}`,
      "KIS_CREDENTIALS_INVALID",
    );
  }

  const appKey = requireSecret(payload.appKey, "appKey");
  const appSecret = requireSecret(payload.appSecret, "appSecret");

  return Object.freeze({
    enabled: true,
    configured: true,
    mode: KIS_MODE_PROD_READ_ONLY,
    environment: "PROD",
    baseUrl: KIS_PROD_BASE_URL,
    credentialsPath: filePath,
    appKey,
    appSecret,
  });
}

export function publicKisConfiguration(config) {
  return {
    enabled: Boolean(config?.enabled),
    configured: Boolean(config?.configured),
    mode: config?.mode ?? KIS_MODE_DISABLED,
    environment: config?.environment ?? null,
    baseUrlHost: config?.baseUrl ? new URL(config.baseUrl).host : null,
    accountConfigured: false,
    orderApiAvailable: false,
  };
}

function requireSecret(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new KisConfigurationError(
      `한국투자 자격정보 ${field}가 비어 있습니다.`,
      "KIS_CREDENTIALS_INVALID",
    );
  }
  return value.trim();
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
