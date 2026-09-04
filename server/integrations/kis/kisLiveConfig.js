import { existsSync, readFileSync } from "node:fs";

export const KIS_LIVE_MODE_DISABLED = "DISABLED";
export const KIS_LIVE_MODE_TRADING = "LIVE_TRADING";
export const KIS_LIVE_BASE_URL = "https://openapi.koreainvestment.com:9443";

const ALLOWED_FILE_FIELDS = new Set([
  "appKey",
  "appSecret",
  "accountNumber",
  "accountProductCode",
]);

export class KisLiveConfigurationError extends Error {
  constructor(message, code = "KIS_LIVE_CONFIGURATION_ERROR") {
    super(message);
    this.name = "KisLiveConfigurationError";
    this.code = code;
    this.statusCode = 503;
  }
}

export function loadKisLiveConfiguration(filePath, { env = process.env } = {}) {
  const mode = String(env.PULSEHFT_KIS_LIVE_MODE ?? KIS_LIVE_MODE_DISABLED)
    .trim()
    .toUpperCase();

  if (mode === KIS_LIVE_MODE_DISABLED) {
    return Object.freeze({
      enabled: false,
      configured: false,
      mode: KIS_LIVE_MODE_DISABLED,
      environment: null,
      baseUrl: null,
      credentialSource: null,
      credentialsPath: filePath,
      orderEnabled: false,
      limits: defaultLimits(env),
    });
  }

  if (mode !== KIS_LIVE_MODE_TRADING) {
    throw new KisLiveConfigurationError(
      `지원하지 않는 한국투자 실전투자 모드입니다: ${mode}`,
      "KIS_LIVE_UNSUPPORTED_MODE",
    );
  }

  const envValues = {
    appKey: optionalSecret(env.PULSEHFT_KIS_LIVE_APP_KEY),
    appSecret: optionalSecret(env.PULSEHFT_KIS_LIVE_APP_SECRET),
    accountNumber: optionalText(env.PULSEHFT_KIS_LIVE_ACCOUNT_NUMBER),
    accountProductCode: optionalText(env.PULSEHFT_KIS_LIVE_ACCOUNT_PRODUCT_CODE),
  };
  const hasAnyEnvCredential = Object.values(envValues).some(Boolean);
  let credentialSource;
  let credentials;

  if (hasAnyEnvCredential) {
    const missing = Object.entries(envValues)
      .filter(([, value]) => !value)
      .map(([field]) => field);
    if (missing.length > 0) {
      throw new KisLiveConfigurationError(
        `한국투자 실전투자 환경변수가 모두 필요합니다. 누락: ${missing.join(", ")}`,
        "KIS_LIVE_CREDENTIALS_INVALID",
      );
    }
    credentialSource = "ENV";
    credentials = envValues;
  } else {
    if (!filePath || !existsSync(filePath)) {
      throw new KisLiveConfigurationError(
        "한국투자 실전투자 자격정보가 없습니다. 실전투자 전용 App Key, App Secret, 계좌번호를 설정하세요.",
        "KIS_LIVE_CREDENTIALS_MISSING",
      );
    }
    let payload;
    try {
      payload = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new KisLiveConfigurationError(
        `한국투자 실전투자 자격정보 파일을 읽을 수 없습니다: ${formatError(error)}`,
        "KIS_LIVE_CREDENTIALS_READ_FAILED",
      );
    }
    if (!isRecord(payload)) {
      throw new KisLiveConfigurationError(
        "한국투자 실전투자 자격정보 파일은 JSON 객체여야 합니다.",
        "KIS_LIVE_CREDENTIALS_INVALID",
      );
    }
    const unknownFields = Object.keys(payload).filter((field) => !ALLOWED_FILE_FIELDS.has(field));
    if (unknownFields.length > 0) {
      throw new KisLiveConfigurationError(
        `한국투자 실전투자 자격정보 파일에 허용되지 않은 필드가 있습니다: ${unknownFields.join(", ")}`,
        "KIS_LIVE_CREDENTIALS_INVALID",
      );
    }
    credentialSource = "FILE";
    credentials = {
      appKey: requireSecret(payload.appKey, "appKey"),
      appSecret: requireSecret(payload.appSecret, "appSecret"),
      accountNumber: requireText(payload.accountNumber, "accountNumber"),
      accountProductCode: requireText(payload.accountProductCode, "accountProductCode"),
    };
  }

  validateAccount(credentials.accountNumber, credentials.accountProductCode);
  rejectPaperAndProdCredentialReuse(credentials, env);

  const orderEnabled = String(env.PULSEHFT_KIS_LIVE_ORDER_ENABLED ?? "false").trim().toLowerCase() === "true";

  return Object.freeze({
    enabled: true,
    configured: true,
    mode: KIS_LIVE_MODE_TRADING,
    environment: "LIVE",
    baseUrl: KIS_LIVE_BASE_URL,
    credentialSource,
    credentialsPath: credentialSource === "FILE" ? filePath : null,
    appKey: credentials.appKey,
    appSecret: credentials.appSecret,
    accountNumber: credentials.accountNumber,
    accountProductCode: credentials.accountProductCode,
    orderEnabled,
    limits: defaultLimits(env),
  });
}

export function publicKisLiveConfiguration(config) {
  return {
    enabled: Boolean(config?.enabled),
    configured: Boolean(config?.configured),
    mode: config?.mode ?? KIS_LIVE_MODE_DISABLED,
    environment: config?.environment ?? null,
    baseUrlHost: config?.baseUrl ? new URL(config.baseUrl).host : null,
    accountConfigured: Boolean(config?.enabled && config?.accountNumber),
    accountNumberMasked: config?.accountNumber ? maskAccount(config.accountNumber) : null,
    balanceApiAvailable: Boolean(config?.enabled),
    orderApiAvailable: Boolean(config?.enabled && config?.orderEnabled),
    limits: config?.limits ? structuredClone(config.limits) : null,
  };
}

function defaultLimits(env) {
  return Object.freeze({
    maxOrderQuantity: integerEnv(env.PULSEHFT_KIS_LIVE_MAX_ORDER_QUANTITY, 1, 1, 1),
    maxOrderValue: integerEnv(env.PULSEHFT_KIS_LIVE_MAX_ORDER_VALUE, 2_000_000, 1, 10_000_000_000),
    maxDailyOrders: integerEnv(env.PULSEHFT_KIS_LIVE_MAX_DAILY_ORDERS, 5, 1, 10_000),
    maxDailyLoss: integerEnv(env.PULSEHFT_KIS_LIVE_MAX_DAILY_LOSS, 20_000, 0, 10_000_000_000),
    maxConsecutiveLosses: integerEnv(env.PULSEHFT_KIS_LIVE_MAX_CONSECUTIVE_LOSSES, 2, 0, 100),
  });
}

function rejectPaperAndProdCredentialReuse(credentials, env) {
  const prodAppKey = optionalSecret(env.PULSEHFT_KIS_APP_KEY);
  const prodAppSecret = optionalSecret(env.PULSEHFT_KIS_APP_SECRET);
  const paperAppKey = optionalSecret(env.PULSEHFT_KIS_PAPER_APP_KEY);
  const paperAppSecret = optionalSecret(env.PULSEHFT_KIS_PAPER_APP_SECRET);

  if (
    (prodAppKey && prodAppKey === credentials.appKey)
    || (prodAppSecret && prodAppSecret === credentials.appSecret)
  ) {
    throw new KisLiveConfigurationError(
      "한국투자 실전 시세 전용 App Key 또는 App Secret을 실전투자 자격정보로 재사용할 수 없습니다.",
      "KIS_LIVE_QUOTE_CREDENTIAL_REUSE",
    );
  }

  if (
    (paperAppKey && paperAppKey === credentials.appKey)
    || (paperAppSecret && paperAppSecret === credentials.appSecret)
  ) {
    throw new KisLiveConfigurationError(
      "모의투자 App Key 또는 App Secret을 실전투자 자격정보로 재사용할 수 없습니다.",
      "KIS_LIVE_PAPER_CREDENTIAL_REUSE",
    );
  }
}

function validateAccount(accountNumber, accountProductCode) {
  if (!/^\d{8}$/.test(accountNumber)) {
    throw new KisLiveConfigurationError(
      "한국투자 실전투자 계좌번호 앞자리는 숫자 8자리여야 합니다.",
      "KIS_LIVE_CREDENTIALS_INVALID",
    );
  }
  if (!/^\d{2}$/.test(accountProductCode)) {
    throw new KisLiveConfigurationError(
      "한국투자 실전투자 계좌상품코드는 숫자 2자리여야 합니다.",
      "KIS_LIVE_CREDENTIALS_INVALID",
    );
  }
}

function integerEnv(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new KisLiveConfigurationError(
      `한국투자 실전투자 안전 한도는 ${minimum} 이상 ${maximum} 이하의 정수여야 합니다.`,
      "KIS_LIVE_LIMIT_INVALID",
    );
  }
  return number;
}

function requireSecret(value, field) {
  const secret = optionalSecret(value);
  if (!secret) {
    throw new KisLiveConfigurationError(
      `한국투자 실전투자 자격정보 ${field}가 비어 있습니다.`,
      "KIS_LIVE_CREDENTIALS_INVALID",
    );
  }
  return secret;
}

function requireText(value, field) {
  const text = optionalText(value);
  if (!text) {
    throw new KisLiveConfigurationError(
      `한국투자 실전투자 자격정보 ${field}가 비어 있습니다.`,
      "KIS_LIVE_CREDENTIALS_INVALID",
    );
  }
  return text;
}

function optionalSecret(value) {
  return optionalText(value);
}

function optionalText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function maskAccount(value) {
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
