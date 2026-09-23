import { KIS_LIVE_MODE_TRADING } from "./kisLiveConfig.js";

const ALLOWED_EXCHANGES = new Set(["KRX", "NXT", "SOR"]);

export class KisLiveApiError extends Error {
  constructor(message, {
    code = "KIS_LIVE_API_ERROR",
    statusCode = 502,
    ambiguous = false,
    operation = null,
  } = {}) {
    super(message);
    this.name = "KisLiveApiError";
    this.code = code;
    this.statusCode = statusCode;
    this.ambiguous = ambiguous;
    this.operation = operation;
  }
}

export function normalizeOrderInput(input) {
  const side = String(input?.side ?? "").trim().toUpperCase();
  if (!new Set(["BUY", "SELL"]).has(side)) throw invalidInput("side는 BUY 또는 SELL이어야 합니다.");
  const symbol = normalizeSymbol(input?.symbol);
  const type = String(input?.type ?? "MARKET").trim().toUpperCase();
  if (!new Set(["MARKET", "LIMIT"]).has(type)) throw invalidInput("type은 MARKET 또는 LIMIT이어야 합니다.");
  const quantity = positiveInteger(input?.quantity, "quantity");
  const limitPrice = type === "LIMIT" ? positiveInteger(input?.limitPrice, "limitPrice") : null;
  const exchange = normalizeExchange(input?.exchange ?? "KRX");
  return { side, symbol, type, quantity, limitPrice, exchange };
}

export function normalizeReviseCancelInput(input, operation) {
  const originalOrderNumber = requireDigits(input?.originalOrderNumber, "originalOrderNumber");
  const orderOrganizationNumber = requireDigits(input?.orderOrganizationNumber, "orderOrganizationNumber");
  const quantity = positiveInteger(input?.quantity, "quantity");
  const rawType = input?.type === undefined || input?.type === null || String(input.type).trim() === ""
    ? null
    : String(input.type).trim().toUpperCase();
  const type = rawType ?? (operation === "REVISE" ? "LIMIT" : null);
  if (type !== null && !new Set(["MARKET", "LIMIT"]).has(type)) {
    throw invalidInput("type은 MARKET 또는 LIMIT이어야 합니다.");
  }
  const limitPrice = type === "LIMIT" ? positiveInteger(input?.limitPrice, "limitPrice") : null;
  const exchange = normalizeExchange(input?.exchange ?? "KRX");
  return {
    operation,
    originalOrderNumber,
    orderOrganizationNumber,
    quantity,
    type,
    limitPrice,
    exchange,
    allQuantity: input?.allQuantity !== false,
  };
}

export function normalizeBalancePages(pages, fetchedAt) {
  const positions = pages.flatMap((payload) => ensureArray(payload?.output1).map((item) => ({
    symbol: textOrNull(firstDefined(item.pdno, item.PDNO)),
    name: textOrNull(firstDefined(item.prdt_name, item.PRDT_NAME)),
    quantity: numberOrZero(firstDefined(item.hldg_qty, item.HLDG_QTY)),
    orderableQuantity: numberOrZero(firstDefined(item.ord_psbl_qty, item.ORD_PSBL_QTY)),
    averagePrice: numberOrZero(firstDefined(item.pchs_avg_pric, item.PCHS_AVG_PRIC)),
    currentPrice: numberOrZero(firstDefined(item.prpr, item.PRPR)),
    evaluationAmount: numberOrZero(firstDefined(item.evlu_amt, item.EVLU_AMT)),
    evaluationProfitLoss: numberOrZero(firstDefined(item.evlu_pfls_amt, item.EVLU_PFLS_AMT)),
    evaluationProfitLossRate: numberOrZero(firstDefined(item.evlu_pfls_rt, item.EVLU_PFLS_RT)),
  })));
  const summarySource = pages.flatMap((payload) => ensureArray(payload?.output2)).at(-1) ?? {};
  return {
    source: "KIS",
    mode: KIS_LIVE_MODE_TRADING,
    environment: "LIVE",
    currency: "KRW",
    fetchedAt,
    positions,
    summary: {
      cash: numberOrZero(firstDefined(summarySource.dnca_tot_amt, summarySource.DNCA_TOT_AMT)),
      purchaseAmount: numberOrZero(firstDefined(summarySource.pchs_amt_smtl_amt, summarySource.PCHS_AMT_SMTL_AMT)),
      evaluationAmount: numberOrZero(firstDefined(summarySource.evlu_amt_smtl_amt, summarySource.EVLU_AMT_SMTL_AMT)),
      evaluationProfitLoss: numberOrZero(firstDefined(summarySource.evlu_pfls_smtl_amt, summarySource.EVLU_PFLS_SMTL_AMT)),
      totalEvaluationAmount: numberOrZero(firstDefined(summarySource.tot_evlu_amt, summarySource.TOT_EVLU_AMT)),
      assetChangeAmount: numberOrZero(firstDefined(summarySource.asst_icdc_amt, summarySource.ASST_ICDC_AMT)),
      assetChangeRate: numberOrZero(firstDefined(summarySource.asst_icdc_erng_rt, summarySource.ASST_ICDC_ERNG_RT)),
    },
  };
}

export function normalizeCancelableOrder(item) {
  return {
    orderOrganizationNumber: textOrNull(firstDefined(item.krx_fwdg_ord_orgno, item.KRX_FWDG_ORD_ORGNO)),
    orderNumber: textOrNull(firstDefined(item.odno, item.ODNO)),
    symbol: textOrNull(firstDefined(item.pdno, item.PDNO)),
    name: textOrNull(firstDefined(item.prdt_name, item.PRDT_NAME)),
    side: normalizeSideName(firstDefined(item.sll_buy_dvsn_cd, item.SLL_BUY_DVSN_CD)),
    orderQuantity: numberOrZero(firstDefined(item.ord_qty, item.ORD_QTY)),
    executedQuantity: numberOrZero(firstDefined(item.tot_ccld_qty, item.TOT_CCLD_QTY)),
    cancelableQuantity: numberOrZero(firstDefined(item.psbl_qty, item.PSBL_QTY)),
    orderPrice: numberOrZero(firstDefined(item.ord_unpr, item.ORD_UNPR)),
    orderDivision: textOrNull(firstDefined(item.ord_dvsn_cd, item.ORD_DVSN_CD)),
  };
}

export function normalizeDailyOrderHistory(pages, fetchedAt) {
  const ordersByKey = new Map();
  for (const payload of pages) {
    for (const item of ensureArray(payload?.output1)) {
      const order = normalizeDailyOrder(item);
      const key = [
        order.orderDate,
        order.orderOrganizationNumber,
        order.orderNumber,
        order.originalOrderNumber,
        order.symbol,
      ].join(":");
      ordersByKey.set(key, order);
    }
  }
  const orders = [...ordersByKey.values()].sort((left, right) => {
    const timeDifference = (right.orderedAt ?? 0) - (left.orderedAt ?? 0);
    if (timeDifference !== 0) return timeDifference;
    return String(right.orderNumber ?? "").localeCompare(String(left.orderNumber ?? ""));
  });
  const summarySource = pages.map((payload) => {
    if (isRecord(payload?.output2)) return payload.output2;
    return ensureArray(payload?.output2).at(-1) ?? null;
  }).filter((item) => item && Object.keys(item).length > 0).at(-1) ?? {};
  return {
    source: "KIS",
    mode: KIS_LIVE_MODE_TRADING,
    environment: "LIVE",
    currency: "KRW",
    fetchedAt,
    orders,
    summary: {
      totalOrderQuantity: numberOrZero(firstDefined(summarySource.tot_ord_qty, summarySource.TOT_ORD_QTY)),
      totalExecutedQuantity: numberOrZero(firstDefined(summarySource.tot_ccld_qty, summarySource.TOT_CCLD_QTY)),
      totalExecutedAmount: numberOrZero(firstDefined(summarySource.tot_ccld_amt, summarySource.TOT_CCLD_AMT)),
      estimatedFeesAndTaxes: numberOrZero(firstDefined(summarySource.prsm_tlex_smtl, summarySource.PRSM_TLEX_SMTL)),
      purchaseAveragePrice: numberOrZero(firstDefined(summarySource.pchs_avg_pric, summarySource.PCHS_AVG_PRIC)),
    },
  };
}

export function normalizeDailyOrder(item) {
  const orderDate = textOrNull(firstDefined(item.ord_dt, item.ORD_DT));
  const orderTime = textOrNull(firstDefined(item.ord_tmd, item.ORD_TMD));
  const orderQuantity = numberOrZero(firstDefined(item.ord_qty, item.ORD_QTY));
  const executedQuantity = numberOrZero(firstDefined(item.tot_ccld_qty, item.TOT_CCLD_QTY));
  const canceledQuantity = numberOrZero(firstDefined(item.cnc_cfrm_qty, item.CNC_CFRM_QTY));
  const remainingQuantity = numberOrZero(firstDefined(item.rmn_qty, item.RMN_QTY));
  const rejectedQuantity = numberOrZero(firstDefined(item.rjct_qty, item.RJCT_QTY));
  const canceled = String(firstDefined(item.cncl_yn, item.CNCL_YN) ?? "").trim().toUpperCase() === "Y"
    || canceledQuantity > 0;
  const orderDivisionCode = textOrNull(firstDefined(item.ord_dvsn_cd, item.ORD_DVSN_CD));
  const orderDivisionName = textOrNull(firstDefined(item.ord_dvsn_name, item.ORD_DVSN_NAME));
  return {
    source: "KIS",
    mode: KIS_LIVE_MODE_TRADING,
    environment: "LIVE",
    orderDate,
    orderTime,
    orderedAt: koreaDateTime(orderDate, orderTime),
    orderOrganizationNumber: textOrNull(firstDefined(
      item.ord_gno_brno,
      item.ORD_GNO_BRNO,
      item.ord_orgno,
      item.ORD_ORGNO,
    )),
    orderNumber: textOrNull(firstDefined(item.odno, item.ODNO)),
    originalOrderNumber: textOrNull(firstDefined(item.orgn_odno, item.ORGN_ODNO)),
    symbol: textOrNull(firstDefined(item.pdno, item.PDNO)),
    name: textOrNull(firstDefined(item.prdt_name, item.PRDT_NAME)),
    side: normalizeSideName(firstDefined(item.sll_buy_dvsn_cd, item.SLL_BUY_DVSN_CD)),
    sideName: textOrNull(firstDefined(item.sll_buy_dvsn_cd_name, item.SLL_BUY_DVSN_CD_NAME)),
    type: normalizeOrderType(orderDivisionCode, orderDivisionName),
    orderDivisionCode,
    orderDivisionName,
    orderQuantity,
    orderPrice: numberOrZero(firstDefined(item.ord_unpr, item.ORD_UNPR)),
    executedQuantity,
    averageExecutedPrice: numberOrZero(firstDefined(item.avg_prvs, item.AVG_PRVS)),
    executedAmount: numberOrZero(firstDefined(item.tot_ccld_amt, item.TOT_CCLD_AMT)),
    canceledQuantity,
    remainingQuantity,
    rejectedQuantity,
    canceled,
    status: dailyOrderStatus({
      orderQuantity,
      executedQuantity,
      canceledQuantity,
      remainingQuantity,
      rejectedQuantity,
      canceled,
    }),
    exchange: textOrNull(firstDefined(
      item.excg_id_dvsn_cd,
      item.EXCG_ID_DVSN_CD,
      item.excg_id_dvsn_Cd,
      item.excg_dvsn_cd,
      item.EXCG_DVSN_CD,
    )),
  };
}

export function normalizeOrderResponse(output, context) {
  if (!isRecord(output)) {
    throw new KisLiveApiError("한국투자 실전주문 응답에 output 객체가 없습니다.", {
      code: "KIS_LIVE_ORDER_INVALID_RESPONSE",
      ambiguous: true,
      operation: context.operation,
    });
  }
  const orderNumber = textOrNull(firstDefined(output.ODNO, output.odno));
  const orderOrganizationNumber = textOrNull(firstDefined(output.KRX_FWDG_ORD_ORGNO, output.krx_fwdg_ord_orgno));
  if (!orderNumber || !orderOrganizationNumber) {
    throw new KisLiveApiError("한국투자 실전주문 응답에 주문번호 또는 주문조직번호가 없습니다.", {
      code: "KIS_LIVE_ORDER_INVALID_RESPONSE",
      ambiguous: true,
      operation: context.operation,
    });
  }
  return {
    source: "KIS",
    mode: KIS_LIVE_MODE_TRADING,
    environment: "LIVE",
    status: "ACCEPTED",
    orderNumber,
    orderOrganizationNumber,
    orderTime: textOrNull(firstDefined(output.ORD_TMD, output.ord_tmd)),
    ...context,
  };
}

export function assertSuccessfulPayload(operation, response, payload, {
  code,
  secrets,
  ambiguousHttp5xx = false,
}) {
  if (!response.ok) {
    throw apiFailure(operation, response.status, payload, {
      code: `${code}_HTTP`,
      secrets,
      ambiguous: ambiguousHttp5xx && response.status >= 500,
    });
  }
  if (String(payload?.rt_cd ?? "") !== "0") {
    throw apiFailure(operation, 502, payload, { code, secrets, ambiguous: false });
  }
}

export async function parseJson(response, operation, ambiguous) {
  try {
    return await response.json();
  } catch {
    throw new KisLiveApiError(`한국투자 ${operation} 응답이 JSON이 아닙니다.`, {
      code: "KIS_LIVE_INVALID_JSON_RESPONSE",
      ambiguous,
      operation,
    });
  }
}

export function apiFailure(operation, status, payload, {
  code,
  secrets = [],
  ambiguous = false,
}) {
  const detail = firstText(payload?.msg1, payload?.error_description, payload?.message);
  const message = redactText(detail, secrets);
  return new KisLiveApiError(`한국투자 ${operation} 실패${message ? `:${message}` : ""}`, {
    code,
    statusCode: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502,
    ambiguous,
    operation,
  });
}

export function invalidInput(message) {
  return new KisLiveApiError(message, {
    code: "KIS_LIVE_INVALID_INPUT",
    statusCode: 400,
    ambiguous: false,
  });
}

export function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw invalidInput(`${field}는 양의 정수여야 합니다.`);
  return number;
}

export function requireDigits(value, field) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) throw invalidInput(`${field}는 숫자 문자열이어야 합니다.`);
  return text;
}

export function normalizeSymbol(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  if (!/^(?:\d{6}|Q\d{6})$/.test(symbol)) {
    throw invalidInput("symbol은 6자리 종목코드 또는 Q로 시작하는 ETN 코드여야 합니다.");
  }
  return symbol;
}

export function normalizeExchange(value) {
  const exchange = String(value ?? "KRX").trim().toUpperCase();
  if (!ALLOWED_EXCHANGES.has(exchange)) {
    throw invalidInput("exchange는 KRX, NXT, SOR 중 하나여야 합니다.");
  }
  return exchange;
}

export function normalizeSideName(value) {
  const code = String(value ?? "").trim();
  if (code === "01" || code.toUpperCase() === "SELL") return "SELL";
  if (code === "02" || code.toUpperCase() === "BUY") return "BUY";
  return null;
}

export function redactText(value, secrets) {
  let text = textOrNull(value);
  if (!text) return text;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) text = text.replaceAll(secret, "[REDACTED]");
  }
  return text;
}

export function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

export function numberOrZero(value) {
  if (value === null || value === undefined || value === "") return 0;
  const number = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(number) ? number : 0;
}

export function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

export function textOrEmpty(value) {
  return textOrNull(value) ?? "";
}

export function textOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

export function firstText(...values) {
  for (const value of values) {
    const text = textOrNull(value);
    if (text) return text;
  }
  return null;
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeOrderType(code, name) {
  if (code === "00") return "LIMIT";
  if (code === "01") return "MARKET";
  const normalizedName = String(name ?? "").trim();
  if (normalizedName.includes("시장")) return "MARKET";
  if (normalizedName.includes("지정")) return "LIMIT";
  return null;
}

function dailyOrderStatus({
  orderQuantity,
  executedQuantity,
  canceledQuantity,
  remainingQuantity,
  rejectedQuantity,
  canceled,
}) {
  if (orderQuantity > 0 && executedQuantity >= orderQuantity) return "FILLED";
  if (canceled || canceledQuantity > 0) {
    return executedQuantity > 0 ? "PARTIALLY_FILLED_CANCELED" : "CANCELED";
  }
  if (rejectedQuantity > 0 && executedQuantity === 0) return "REJECTED";
  if (executedQuantity > 0) return "PARTIALLY_FILLED";
  if (remainingQuantity > 0) return "OPEN";
  if (orderQuantity > 0) return "ACCEPTED";
  return "UNKNOWN";
}

function koreaDateTime(date, time) {
  const dateDigits = String(date ?? "").replace(/\D/g, "");
  const timeDigits = String(time ?? "").replace(/\D/g, "").padStart(6, "0");
  if (!/^\d{8}$/.test(dateDigits) || !/^\d{6}$/.test(timeDigits)) return null;
  const year = Number(dateDigits.slice(0, 4));
  const month = Number(dateDigits.slice(4, 6));
  const day = Number(dateDigits.slice(6, 8));
  const hour = Number(timeDigits.slice(0, 2));
  const minute = Number(timeDigits.slice(2, 4));
  const second = Number(timeDigits.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  return Date.UTC(year, month - 1, day, hour - 9, minute, second);
}
