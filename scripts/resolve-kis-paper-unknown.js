import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
const RESOLUTIONS = new Set(["ACCEPTED", "NOT_ACCEPTED"]);

export class KisPaperUnknownResolutionError extends Error {
  constructor(message, { code = "KIS_PAPER_UNKNOWN_RESOLUTION_FAILED", details = null } = {}) {
    super(message);
    this.name = "KisPaperUnknownResolutionError";
    this.code = code;
    this.details = details;
  }
}

export async function runKisPaperUnknownResolution({
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
  clientOrderId = null,
  resolution = null,
  brokerOrderNumber = null,
  orderOrganizationNumber = null,
  note = null,
  now = Date.now,
  logger = console,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetch 구현이 필요합니다.");
  }
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const startedAt = now();
  const status = await requestJson(fetchImpl, normalizedBaseUrl, "/api/kis/paper/status");
  assertPaperEnabled(status);
  const unknownCommands = Array.isArray(status?.service?.unknownCommands)
    ? status.service.unknownCommands
    : [];

  if (unknownCommands.length === 0) {
    logger.info?.("[KIS 대조] 해소할 주문 결과 불명 상태가 없습니다.");
    return {
      status: "NONE",
      startedAt,
      completedAt: now(),
      baseUrl: normalizedBaseUrl,
      unknownCommands: [],
      killSwitch: Boolean(status?.service?.killSwitch),
      reconciliation: status?.service?.reconciliation ?? null,
    };
  }

  const target = clientOrderId === null || clientOrderId === undefined || String(clientOrderId).trim() === ""
    ? null
    : String(clientOrderId).trim();
  const normalizedResolution = resolution === null || resolution === undefined || String(resolution).trim() === ""
    ? null
    : String(resolution).trim().toUpperCase();

  if (!target || !normalizedResolution) {
    const brokerOrders = await loadBrokerOrders(fetchImpl, normalizedBaseUrl);
    const tracked = new Set((status?.service?.trackedOrderNumbers ?? [])
      .map((orderNumber) => textOrNull(orderNumber))
      .filter(Boolean));
    const review = {
      status: "REVIEW",
      startedAt,
      completedAt: now(),
      baseUrl: normalizedBaseUrl,
      unknownCommands: structuredClone(unknownCommands),
      candidates: unknownCommands.map((command) => ({
        clientOrderId: command.clientOrderId,
        operation: command.operation,
        request: command.request ?? null,
        brokerOrders: brokerOrders.filter((order) => !tracked.has(textOrNull(order?.orderNumber))
          && matchesCommand(command, order)),
      })),
      brokerOrders,
      guidance: "KIS 모의계좌 주문내역과 직접 대조한 뒤 --client-order-id와 --resolution=ACCEPTED|NOT_ACCEPTED로 다시 실행합니다.",
      killSwitch: Boolean(status?.service?.killSwitch),
      reconciliation: status?.service?.reconciliation ?? null,
    };
    logger.info?.(`[KIS 대조] 결과 불명 명령 ${unknownCommands.length}건을 확인했습니다. 증권사 주문내역과 대조하세요.`);
    return review;
  }

  if (!RESOLUTIONS.has(normalizedResolution)) {
    throw new KisPaperUnknownResolutionError(
      "resolution은 ACCEPTED 또는 NOT_ACCEPTED여야 합니다.",
      { code: "KIS_PAPER_UNKNOWN_RESOLUTION_INVALID" },
    );
  }
  const command = unknownCommands.find((item) => item.clientOrderId === target);
  if (!command) {
    throw new KisPaperUnknownResolutionError(
      `clientOrderId ${target}는 결과 불명 상태 목록에 없습니다.`,
      {
        code: "KIS_PAPER_UNKNOWN_COMMAND_NOT_FOUND",
        details: { unknownCommands: unknownCommands.map((item) => item.clientOrderId) },
      },
    );
  }
  if (normalizedResolution === "ACCEPTED" && !textOrNull(brokerOrderNumber)) {
    throw new KisPaperUnknownResolutionError(
      "증권사 접수로 확정하려면 KIS 주문내역에서 확인한 주문번호(--broker-order-number)가 필요합니다.",
      { code: "KIS_PAPER_UNKNOWN_RESOLUTION_ORDER_NUMBER_REQUIRED" },
    );
  }

  const resolved = await requestJson(fetchImpl, normalizedBaseUrl, "/api/kis/paper/orders/resolve-unknown", {
    method: "POST",
    body: {
      clientOrderId: target,
      resolution: normalizedResolution,
      brokerOrderNumber: textOrNull(brokerOrderNumber),
      orderOrganizationNumber: textOrNull(orderOrganizationNumber),
      note: textOrNull(note),
    },
  });
  const after = await requestJson(fetchImpl, normalizedBaseUrl, "/api/kis/paper/status");
  const remaining = Array.isArray(after?.service?.unknownCommands) ? after.service.unknownCommands : [];
  logger.info?.(
    `[KIS 대조] ${target}를 ${normalizedResolution}로 확정했습니다. 남은 결과 불명 명령 ${remaining.length}건.`,
  );
  return {
    status: "RESOLVED",
    startedAt,
    completedAt: now(),
    baseUrl: normalizedBaseUrl,
    clientOrderId: target,
    resolution: normalizedResolution,
    command: structuredClone(command),
    matchedOrder: resolved?.matchedOrder ?? null,
    remainingUnknownCommands: structuredClone(remaining),
    killSwitch: Boolean(after?.service?.killSwitch),
    unknownResult: Boolean(after?.service?.unknownResult),
    reconciliation: after?.service?.reconciliation ?? null,
  };
}

async function loadBrokerOrders(fetchImpl, baseUrl) {
  const snapshot = await requestJson(fetchImpl, baseUrl, "/api/snapshot");
  const orders = snapshot?.account?.orders;
  return Array.isArray(orders) ? structuredClone(orders) : [];
}

function matchesCommand(command, order) {
  const request = command?.request ?? {};
  if (String(command?.operation ?? "").toUpperCase() === "SUBMIT") {
    const symbol = textOrNull(request.symbol);
    return symbol !== null
      && symbol === textOrNull(order?.symbol)
      && String(request.side ?? "").toUpperCase() === String(order?.side ?? "").toUpperCase()
      && Number(request.quantity) === Number(order?.orderQuantity);
  }
  const originalOrderNumber = textOrNull(request.originalOrderNumber);
  return originalOrderNumber !== null && originalOrderNumber === textOrNull(order?.originalOrderNumber);
}

async function requestJson(fetchImpl, baseUrl, pathname, { method = "GET", body } = {}) {
  const response = await fetchImpl(new URL(pathname, baseUrl), {
    method,
    headers: {
      Accept: "application/json",
      ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
    },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new KisPaperUnknownResolutionError(
      payload.error ?? payload.message ?? `HTTP ${response.status} 요청 실패`,
      {
        code: payload.code ?? "KIS_PAPER_UNKNOWN_RESOLUTION_HTTP_ERROR",
        details: { status: response.status, pathname },
      },
    );
  }
  return payload;
}

function assertPaperEnabled(status) {
  if (!status?.enabled || !status?.orderApiAvailable) {
    throw new KisPaperUnknownResolutionError(
      "KIS 모의투자 주문 API가 비활성화되어 있어 결과 불명 상태를 대조할 수 없습니다.",
      { code: "KIS_PAPER_UNKNOWN_RESOLUTION_ORDER_API_DISABLED" },
    );
  }
  if (status?.environment !== "PAPER") {
    throw new KisPaperUnknownResolutionError(
      "모의투자 환경이 아닌 연결에서는 실행할 수 없습니다.",
      { code: "KIS_PAPER_UNKNOWN_RESOLUTION_ENVIRONMENT_INVALID" },
    );
  }
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value ?? DEFAULT_BASE_URL));
  if (!/^https?:$/.test(url.protocol)) {
    throw new TypeError("PULSEHFT_BASE_URL은 http 또는 https URL이어야 합니다.");
  }
  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}

function textOrNull(value) {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result || null;
}

function safeError(error) {
  return {
    name: error?.name ?? "Error",
    code: error?.code ?? null,
    message: error instanceof Error ? error.message : String(error),
    details: error?.details ?? null,
  };
}

export function parseArguments(argv) {
  const options = {};
  for (const argument of argv) {
    const match = String(argument).match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!match) continue;
    options[match[1]] = match[2] ?? "";
  }
  return {
    baseUrl: options["base-url"] ?? process.env.PULSEHFT_BASE_URL ?? DEFAULT_BASE_URL,
    clientOrderId: options["client-order-id"] ?? null,
    resolution: options.resolution ?? null,
    brokerOrderNumber: options["broker-order-number"] ?? null,
    orderOrganizationNumber: options["order-organization-number"] ?? null,
    note: options.note ?? null,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.clientOrderId && options.resolution
    && process.env.PULSEHFT_RESOLVE_KIS_PAPER_UNKNOWN !== "YES") {
    throw new KisPaperUnknownResolutionError(
      "주문 결과 불명 상태 확정은 증권사 주문내역 대조를 마친 뒤 PULSEHFT_RESOLVE_KIS_PAPER_UNKNOWN=YES를 명시해야 실행됩니다.",
      { code: "KIS_PAPER_UNKNOWN_RESOLUTION_OPT_IN_REQUIRED" },
    );
  }
  const report = await runKisPaperUnknownResolution(options);
  const reportPath = resolve(
    process.env.PULSEHFT_UNKNOWN_RESOLUTION_REPORT_PATH
      ?? ".pulsehft/kis-paper-unknown-resolution-latest.json",
  );
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log(`REPORT=${reportPath}`);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entry === import.meta.url) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: "FAIL", error: safeError(error) }, null, 2));
    process.exitCode = 1;
  });
}
