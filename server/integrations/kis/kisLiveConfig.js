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
      autoTradingEnabled: false,
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
  const allowSharedQuoteCredential = String(
    env.PULSEHFT_KIS_LIVE_ALLOW_SHARED_QUOTE_CREDENTIAL ?? "false",
  ).trim().toLowerCase() === "true";
  const sharedQuoteCredential = rejectPaperAndProdCredentialReuse(credentials, env, {
    allowSharedQuoteCredential,
  });

  const orderEnabled = String(env.PULSEHFT_KIS_LIVE_ORDER_ENABLED ?? "false").trim().toLowerCase() === "true";
  // 실전 자동매매는 주문 게이트와 별개로 한 번 더 켜야 한다(이중 게이트 위에 세 번째 게이트).
  const autoTradingEnabled = orderEnabled && isAutoTradingFlag(env);

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
    autoTradingEnabled,
    sharedQuoteCredential,
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
    autoTradingAvailable: Boolean(config?.enabled && config?.orderEnabled && config?.autoTradingEnabled),
    sharedQuoteCredential: Boolean(config?.sharedQuoteCredential),
    limits: config?.limits ? structuredClone(config.limits) : null,
  };
}

function isAutoTradingFlag(env) {
  return String(env.PULSEHFT_KIS_LIVE_AUTO_TRADING_ENABLED ?? "false").trim().toLowerCase() === "true";
}

// 수동 카나리 기본값(1주/2,000,000원/5건/2만원/2회)과 실전 자동매매 "소액 시험" 기본값. 자동매매
// 플래그를 켠 경우에만 후자가 기본이 된다. 수량 상한은 자동매매 주문에만 쓰이고(수동 주문은
// kisLiveOrderService의 1주 카나리가 그대로 막는다), 실제 규모는 maxOrderValue가 먼저 제한한다.
// 모든 값은 PULSEHFT_KIS_LIVE_MAX_*로 덮어쓸 수 있다.
const MANUAL_LIMIT_DEFAULTS = Object.freeze({
  maxOrderQuantity: 1, maxOrderValue: 2_000_000, maxDailyOrders: 5, maxDailyLoss: 20_000, maxConsecutiveLosses: 2,
});
const AUTO_TRADING_LIMIT_DEFAULTS = Object.freeze({
  maxOrderQuantity: 1_000, maxOrderValue: 200_000, maxDailyOrders: 30, maxDailyLoss: 50_000, maxConsecutiveLosses: 3,
});

function defaultLimits(env) {
  const defaults = isAutoTradingFlag(env) ? AUTO_TRADING_LIMIT_DEFAULTS : MANUAL_LIMIT_DEFAULTS;
  return Object.freeze({
    maxOrderQuantity: integerEnv(env.PULSEHFT_KIS_LIVE_MAX_ORDER_QUANTITY, defaults.maxOrderQuantity, 1, 10_000),
    maxOrderValue: integerEnv(env.PULSEHFT_KIS_LIVE_MAX_ORDER_VALUE, defaults.maxOrderValue, 1, 10_000_000_000),
    maxDailyOrders: integerEnv(env.PULSEHFT_KIS_LIVE_MAX_DAILY_ORDERS, defaults.maxDailyOrders, 1, 10_000),
    maxDailyLoss: integerEnv(env.PULSEHFT_KIS_LIVE_MAX_DAILY_LOSS, defaults.maxDailyLoss, 0, 10_000_000_000),
    maxConsecutiveLosses: integerEnv(env.PULSEHFT_KIS_LIVE_MAX_CONSECUTIVE_LOSSES, defaults.maxConsecutiveLosses, 0, 100),
  });
}

// 실전 시세용 자격정보 공유는 기본적으로 금지한다. KIS는 계좌마다 App Key를 발급하므로 시세용과
// 주문용을 다른 계좌로 분리하는 것이 원래 설계다(docs/KIS_LIVE_TRADING.md).
// 실전 계좌를 하나만 쓰는 등 분리가 불가능한 경우에 한해
// PULSEHFT_KIS_LIVE_ALLOW_SHARED_QUOTE_CREDENTIAL=true로 명시적으로 옵트인할 수 있으며,
// 이때 공유 사실은 설정 객체·상태 API·기동 경고·실행 저널에 남는다.
// 모의투자 자격정보 재사용은 옵트인 대상이 아니며 항상 거부한다(도메인이 달라 항상 설정 오류다).
function rejectPaperAndProdCredentialReuse(credentials, env, { allowSharedQuoteCredential = false } = {}) {
  const prodAppKey = optionalSecret(env.PULSEHFT_KIS_APP_KEY);
  const prodAppSecret = optionalSecret(env.PULSEHFT_KIS_APP_SECRET);
  const paperAppKey = optionalSecret(env.PULSEHFT_KIS_PAPER_APP_KEY);
  const paperAppSecret = optionalSecret(env.PULSEHFT_KIS_PAPER_APP_SECRET);

  const quoteCredentialShared = Boolean(
    (prodAppKey && prodAppKey === credentials.appKey)
    || (prodAppSecret && prodAppSecret === credentials.appSecret),
  );

  if (quoteCredentialShared && !allowSharedQuoteCredential) {
    throw new KisLiveConfigurationError(
      "한국투자 실전 시세 전용 App Key 또는 App Secret을 실전투자 자격정보로 재사용할 수 없습니다. "
      + "분리가 불가능하면 PULSEHFT_KIS_LIVE_ALLOW_SHARED_QUOTE_CREDENTIAL=true로 명시적으로 허용하세요.",
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

  return quoteCredentialShared;
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
