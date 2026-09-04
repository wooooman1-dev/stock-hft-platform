import { existsSync, readFileSync } from "node:fs";

export const KIS_PAPER_MODE_DISABLED = "DISABLED";
export const KIS_PAPER_MODE_TRADING = "PAPER_TRADING";
export const KIS_PAPER_BASE_URL = "https://openapivts.koreainvestment.com:29443";

const ALLOWED_FILE_FIELDS = new Set([
  "appKey",
  "appSecret",
  "accountNumber",
  "accountProductCode",
]);

export class KisPaperConfigurationError extends Error {
  constructor(message, code = "KIS_PAPER_CONFIGURATION_ERROR") {
    super(message);
    this.name = "KisPaperConfigurationError";
    this.code = code;
    this.statusCode = 503;
  }
}

export function loadKisPaperConfiguration(filePath, { env = process.env } = {}) {
  const mode = String(env.PULSEHFT_KIS_PAPER_MODE ?? KIS_PAPER_MODE_DISABLED)
    .trim()
    .toUpperCase();

  if (mode === KIS_PAPER_MODE_DISABLED) {
    return Object.freeze({
      enabled: false,
      configured: false,
      mode: KIS_PAPER_MODE_DISABLED,
      environment: null,
      baseUrl: null,
      credentialSource: null,
      credentialsPath: filePath,
      limits: defaultLimits(env),
    });
  }

  if (mode !== KIS_PAPER_MODE_TRADING) {
    throw new KisPaperConfigurationError(
      `지원하지 않는 한국투자 모의투자 모드입니다: ${mode}`,
      "KIS_PAPER_UNSUPPORTED_MODE",
    );
  }

  const envValues = {
    appKey: optionalSecret(env.PULSEHFT_KIS_PAPER_APP_KEY),
    appSecret: optionalSecret(env.PULSEHFT_KIS_PAPER_APP_SECRET),
    accountNumber: optionalText(env.PULSEHFT_KIS_PAPER_ACCOUNT_NUMBER),
    accountProductCode: optionalText(env.PULSEHFT_KIS_PAPER_ACCOUNT_PRODUCT_CODE),
  };
  const hasAnyEnvCredential = Object.values(envValues).some(Boolean);
  let credentialSource;
  let credentials;

  if (hasAnyEnvCredential) {
    const missing = Object.entries(envValues)
      .filter(([, value]) => !value)
      .map(([field]) => field);
    if (missing.length > 0) {
      throw new KisPaperConfigurationError(
        `한국투자 모의투자 환경변수가 모두 필요합니다. 누락: ${missing.join(", ")}`,
        "KIS_PAPER_CREDENTIALS_INVALID",
      );
    }
    credentialSource = "ENV";
    credentials = envValues;
  } else {
    if (!filePath || !existsSync(filePath)) {
      throw new KisPaperConfigurationError(
        "한국투자 모의투자 자격정보가 없습니다. 모의투자 전용 App Key, App Secret, 계좌번호를 설정하세요.",
        "KIS_PAPER_CREDENTIALS_MISSING",
      );
    }
    let payload;
    try {
      payload = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new KisPaperConfigurationError(
        `한국투자 모의투자 자격정보 파일을 읽을 수 없습니다: ${formatError(error)}`,
        "KIS_PAPER_CREDENTIALS_READ_FAILED",
      );
    }
    if (!isRecord(payload)) {
      throw new KisPaperConfigurationError(
        "한국투자 모의투자 자격정보 파일은 JSON 객체여야 합니다.",
        "KIS_PAPER_CREDENTIALS_INVALID",
      );
    }
    const unknownFields = Object.keys(payload).filter((field) => !ALLOWED_FILE_FIELDS.has(field));
    if (unknownFields.length > 0) {
      throw new KisPaperConfigurationError(
        `한국투자 모의투자 자격정보 파일에 허용되지 않은 필드가 있습니다: ${unknownFields.join(", ")}`,
        "KIS_PAPER_CREDENTIALS_INVALID",
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
  rejectProductionCredentialReuse(credentials, env);

  return Object.freeze({
    enabled: true,
    configured: true,
    mode: KIS_PAPER_MODE_TRADING,
    environment: "PAPER",
    baseUrl: KIS_PAPER_BASE_URL,
    credentialSource,
    credentialsPath: credentialSource === "FILE" ? filePath : null,
    appKey: credentials.appKey,
    appSecret: credentials.appSecret,
    accountNumber: credentials.accountNumber,
    accountProductCode: credentials.accountProductCode,
    limits: defaultLimits(env),
  });
}

export function publicKisPaperConfiguration(config) {
  return {
    enabled: Boolean(config?.enabled),
    configured: Boolean(config?.configured),
    mode: config?.mode ?? KIS_PAPER_MODE_DISABLED,
    environment: config?.environment ?? null,
    baseUrlHost: config?.baseUrl ? new URL(config.baseUrl).host : null,
    accountConfigured: Boolean(config?.enabled && config?.accountNumber),
    accountNumberMasked: config?.accountNumber ? maskAccount(config.accountNumber) : null,
    balanceApiAvailable: Boolean(config?.enabled),
    orderApiAvailable: Boolean(config?.enabled),
    limits: config?.limits ? structuredClone(config.limits) : null,
  };
}

function defaultLimits(env) {
  return Object.freeze({
    maxOrderQuantity: integerEnv(env.PULSEHFT_KIS_PAPER_MAX_ORDER_QUANTITY, 10, 1, 10_000),
    maxOrderValue: integerEnv(env.PULSEHFT_KIS_PAPER_MAX_ORDER_VALUE, 1_000_000, 1, 10_000_000_000),
    maxDailyOrders: integerEnv(env.PULSEHFT_KIS_PAPER_MAX_DAILY_ORDERS, 20, 1, 10_000),
    maxDailyLoss: integerEnv(env.PULSEHFT_KIS_PAPER_MAX_DAILY_LOSS, 100_000, 0, 10_000_000_000),
    maxConsecutiveLosses: integerEnv(env.PULSEHFT_KIS_PAPER_MAX_CONSECUTIVE_LOSSES, 3, 0, 100),
  });
}

function rejectProductionCredentialReuse(credentials, env) {
  const productionAppKey = optionalSecret(env.PULSEHFT_KIS_APP_KEY);
  const productionAppSecret = optionalSecret(env.PULSEHFT_KIS_APP_SECRET);
  if (
    (productionAppKey && productionAppKey === credentials.appKey)
    || (productionAppSecret && productionAppSecret === credentials.appSecret)
  ) {
    throw new KisPaperConfigurationError(
      "실전투자 App Key 또는 App Secret을 모의투자 자격정보로 재사용할 수 없습니다.",
      "KIS_PAPER_PRODUCTION_CREDENTIAL_REUSE",
    );
  }
}

function validateAccount(accountNumber, accountProductCode) {
  if (!/^\d{8}$/.test(accountNumber)) {
    throw new KisPaperConfigurationError(
      "한국투자 모의투자 계좌번호 앞자리는 숫자 8자리여야 합니다.",
      "KIS_PAPER_CREDENTIALS_INVALID",
    );
  }
  if (!/^\d{2}$/.test(accountProductCode)) {
    throw new KisPaperConfigurationError(
      "한국투자 모의투자 계좌상품코드는 숫자 2자리여야 합니다.",
      "KIS_PAPER_CREDENTIALS_INVALID",
    );
  }
}

function integerEnv(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new KisPaperConfigurationError(
      `한국투자 모의투자 안전 한도는 ${minimum} 이상 ${maximum} 이하의 정수여야 합니다.`,
      "KIS_PAPER_LIMIT_INVALID",
    );
  }
  return number;
}

function requireSecret(value, field) {
  const secret = optionalSecret(value);
  if (!secret) {
    throw new KisPaperConfigurationError(
      `한국투자 모의투자 자격정보 ${field}가 비어 있습니다.`,
      "KIS_PAPER_CREDENTIALS_INVALID",
    );
  }
  return secret;
}

function requireText(value, field) {
  const text = optionalText(value);
  if (!text) {
    throw new KisPaperConfigurationError(
      `한국투자 모의투자 자격정보 ${field}가 비어 있습니다.`,
      "KIS_PAPER_CREDENTIALS_INVALID",
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
