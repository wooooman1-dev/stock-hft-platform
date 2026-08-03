import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MARKET_OPEN_MINUTE = 9 * 60 + 5;
const MARKET_CLOSE_MINUTE = 15 * 60 + 10;
const WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

export class KisPaperRoundTripError extends Error {
  constructor(message, { code = "KIS_PAPER_ROUNDTRIP_FAILED", details = null } = {}) {
    super(message);
    this.name = "KisPaperRoundTripError";
    this.code = code;
    this.details = details;
  }
}

export function koreaMarketWindow(timestamp = Date.now()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Seoul",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]),
  );
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const minutes = hour * 60 + minute;
  const weekday = parts.weekday;
  return {
    weekday,
    hour,
    minute,
    minutes,
    allowed: WEEKDAYS.has(weekday)
      && minutes >= MARKET_OPEN_MINUTE
      && minutes <= MARKET_CLOSE_MINUTE,
  };
}

export async function runKisPaperRoundTrip({
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
  quantity = 1,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  now = Date.now,
  sleepFn = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  idFactory = randomUUID,
  allowOffHours = false,
  logger = console,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetch 구현이 필요합니다.");
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new KisPaperRoundTripError("검증 수량은 1주 이상의 정수여야 합니다.", {
      code: "KIS_PAPER_ROUNDTRIP_QUANTITY_INVALID",
    });
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
    throw new TypeError("timeoutMs는 1초 이상이어야 합니다.");
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 50) {
    throw new TypeError("pollIntervalMs는 50ms 이상이어야 합니다.");
  }

  const startedAt = now();
  const marketWindow = koreaMarketWindow(startedAt);
  if (!allowOffHours && !marketWindow.allowed) {
    throw new KisPaperRoundTripError(
      "실제 KIS 모의 시장가 왕복 검증은 평일 09:05~15:10 KST에만 실행합니다.",
      {
        code: "KIS_PAPER_ROUNDTRIP_OUTSIDE_MARKET_WINDOW",
        details: marketWindow,
      },
    );
  }

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const health = await requestJson(fetchImpl, normalizedBaseUrl, "/health");
  assertHealthReady(health);

  const before = await requestJson(fetchImpl, normalizedBaseUrl, "/api/snapshot");
  assertSnapshotReady(before, quantity);

  const initialQuantity = positionQuantity(before);
  const initialCash = finiteNumber(before.account?.availableCash);
  const initialEquity = finiteNumber(before.account?.equity);
  const buyClientOrderId = createClientOrderId("buy", startedAt, idFactory);
  const sellClientOrderId = createClientOrderId("sell", startedAt, idFactory);
  let buyResult = null;
  let sellResult = null;
  let afterBuy = null;
  let afterSell = null;
  let postBuyRisk = false;

  logger.info?.(`[KIS 검증] ${before.symbol} ${before.symbolName} ${quantity}주 왕복 검증 시작`);

  try {
    buyResult = await requestJson(fetchImpl, normalizedBaseUrl, "/api/kis/paper/orders", {
      method: "POST",
      body: {
        side: "BUY",
        symbol: before.symbol,
        type: "MARKET",
        quantity,
        referencePrice: before.lastPrice,
        exchange: "KRX",
        clientOrderId: buyClientOrderId,
      },
    });
    assertAccepted(buyResult, "매수");
    postBuyRisk = true;

    afterBuy = await waitForSnapshot({
      fetchImpl,
      baseUrl: normalizedBaseUrl,
      timeoutMs,
      pollIntervalMs,
      now,
      sleepFn,
      label: "매수 잔고 및 실행 저널 반영",
      predicate: (current) => (
        positionQuantity(current) >= initialQuantity + quantity
        && commandStatus(current, buyClientOrderId) === "ACCEPTED"
      ),
    });

    sellResult = await requestJson(fetchImpl, normalizedBaseUrl, "/api/kis/paper/orders", {
      method: "POST",
      body: {
        side: "SELL",
        symbol: before.symbol,
        type: "MARKET",
        quantity,
        referencePrice: afterBuy.lastPrice,
        exchange: "KRX",
        clientOrderId: sellClientOrderId,
      },
    });
    assertAccepted(sellResult, "매도");

    afterSell = await waitForSnapshot({
      fetchImpl,
      baseUrl: normalizedBaseUrl,
      timeoutMs,
      pollIntervalMs,
      now,
      sleepFn,
      label: "매도 잔고 및 실행 저널 반영",
      predicate: (current) => (
        positionQuantity(current) === initialQuantity
        && commandStatus(current, sellClientOrderId) === "ACCEPTED"
      ),
    });
    postBuyRisk = false;

    const completedAt = now();
    const report = {
      status: "PASS",
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
      baseUrl: normalizedBaseUrl,
      symbol: before.symbol,
      symbolName: before.symbolName,
      quantity,
      before: accountEvidence(before),
      buy: orderEvidence(buyClientOrderId, buyResult, afterBuy),
      afterBuy: accountEvidence(afterBuy),
      sell: orderEvidence(sellClientOrderId, sellResult, afterSell),
      after: accountEvidence(afterSell),
      verified: {
        buyPositionIncrease: positionQuantity(afterBuy) >= initialQuantity + quantity,
        finalPositionRestored: positionQuantity(afterSell) === initialQuantity,
        buyJournalCommandRestored: commandStatus(afterSell, buyClientOrderId) === "ACCEPTED",
        sellJournalCommandRestored: commandStatus(afterSell, sellClientOrderId) === "ACCEPTED",
        initialCash,
        finalCash: finiteNumber(afterSell.account?.availableCash),
        initialEquity,
        finalEquity: finiteNumber(afterSell.account?.equity),
      },
    };
    logger.info?.("[KIS 검증] 매수·매도 왕복 및 초기 보유수량 복귀 확인 완료");
    return report;
  } catch (error) {
    let killSwitch = null;
    if (postBuyRisk) {
      try {
        killSwitch = await requestJson(fetchImpl, normalizedBaseUrl, "/api/kis/paper/kill-switch", {
          method: "POST",
          body: { enabled: true },
        });
      } catch (killSwitchError) {
        killSwitch = {
          enabled: null,
          error: safeError(killSwitchError),
        };
      }
    }
    throw new KisPaperRoundTripError(
      postBuyRisk
        ? "매수 접수 이후 왕복 검증을 완료하지 못해 KIS 모의계좌 킬 스위치 활성화를 시도했습니다. 추가 주문을 보내지 말고 계좌와 주문내역을 대조하세요."
        : error instanceof Error ? error.message : String(error),
      {
        code: postBuyRisk
          ? "KIS_PAPER_ROUNDTRIP_INCOMPLETE_AFTER_BUY"
          : error?.code ?? "KIS_PAPER_ROUNDTRIP_FAILED",
        details: {
          originalError: safeError(error),
          symbol: before?.symbol ?? null,
          quantity,
          initialQuantity,
          buyClientOrderId,
          sellClientOrderId,
          buyResult,
          sellResult,
          afterBuy: afterBuy ? accountEvidence(afterBuy) : null,
          afterSell: afterSell ? accountEvidence(afterSell) : null,
          killSwitch,
        },
      },
    );
  }
}

async function waitForSnapshot({
  fetchImpl,
  baseUrl,
  timeoutMs,
  pollIntervalMs,
  now,
  sleepFn,
  label,
  predicate,
}) {
  const startedAt = now();
  let latest = null;
  while (now() - startedAt <= timeoutMs) {
    latest = await requestJson(fetchImpl, baseUrl, "/api/kis/main/refresh", {
      method: "POST",
      body: {},
    });
    assertSnapshotSafe(latest);
    if (predicate(latest)) return latest;
    await sleepFn(pollIntervalMs);
  }
  throw new KisPaperRoundTripError(`${label}을 ${timeoutMs}ms 안에 확인하지 못했습니다.`, {
    code: "KIS_PAPER_ROUNDTRIP_TIMEOUT",
    details: latest ? accountEvidence(latest) : null,
  });
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
    throw new KisPaperRoundTripError(
      payload.error ?? payload.message ?? `HTTP ${response.status} 요청 실패`,
      {
        code: payload.code ?? "KIS_PAPER_ROUNDTRIP_HTTP_ERROR",
        details: { status: response.status, pathname },
      },
    );
  }
  return payload;
}

function assertHealthReady(health) {
  if (health?.status !== "ok") {
    throw new KisPaperRoundTripError("PulseHFT 서버 상태가 정상인지 확인할 수 없습니다.", {
      code: "KIS_PAPER_ROUNDTRIP_SERVER_NOT_READY",
    });
  }
  if (!health?.kisPaper?.orderApiAvailable) {
    throw new KisPaperRoundTripError("KIS 모의투자 주문 API가 비활성화되어 있습니다.", {
      code: "KIS_PAPER_ROUNDTRIP_ORDER_API_DISABLED",
    });
  }
  if (health.kisPaper.killSwitch || health.kisPaper.unknownResult) {
    throw new KisPaperRoundTripError("KIS 모의계좌 킬 스위치 또는 주문 결과 불명 상태가 활성화되어 있습니다.", {
      code: "KIS_PAPER_ROUNDTRIP_ACCOUNT_BLOCKED",
      details: health.kisPaper,
    });
  }
}

function assertSnapshotReady(snapshot, quantity) {
  assertSnapshotSafe(snapshot);
  if (snapshot?.system?.accountMode !== "KIS_PAPER_TRADING" || !snapshot?.account?.available) {
    throw new KisPaperRoundTripError("메인 화면이 사용 가능한 KIS 모의계좌와 연결되어 있지 않습니다.", {
      code: "KIS_PAPER_ROUNDTRIP_ACCOUNT_UNAVAILABLE",
    });
  }
  if (!/^(?:\d{6}|Q\d{6})$/.test(String(snapshot.symbol ?? ""))) {
    throw new KisPaperRoundTripError("검증할 종목코드가 올바르지 않습니다.", {
      code: "KIS_PAPER_ROUNDTRIP_SYMBOL_INVALID",
    });
  }
  const price = Number(snapshot.lastPrice);
  if (!Number.isFinite(price) || price <= 0) {
    throw new KisPaperRoundTripError("KIS 기준 가격을 확인할 수 없습니다.", {
      code: "KIS_PAPER_ROUNDTRIP_PRICE_UNAVAILABLE",
    });
  }
  const limits = snapshot.riskLimits ?? {};
  if (quantity > Number(limits.maxOrderQuantity)) {
    throw new KisPaperRoundTripError("검증 수량이 KIS 모의주문 1회 최대 수량을 초과합니다.", {
      code: "KIS_PAPER_ROUNDTRIP_QUANTITY_LIMIT",
    });
  }
  if (quantity * price > Number(limits.maxOrderValue)) {
    throw new KisPaperRoundTripError("검증 주문금액이 KIS 모의주문 최대 금액을 초과합니다.", {
      code: "KIS_PAPER_ROUNDTRIP_VALUE_LIMIT",
    });
  }
  if (Number(snapshot.account.openOrderCount) > 0 || Number(snapshot.account.reservedSellQuantity) > 0) {
    throw new KisPaperRoundTripError("기존 미체결 주문 또는 매도 예약이 있어 왕복 검증을 시작하지 않습니다.", {
      code: "KIS_PAPER_ROUNDTRIP_OPEN_ORDERS_EXIST",
      details: {
        openOrderCount: snapshot.account.openOrderCount,
        reservedSellQuantity: snapshot.account.reservedSellQuantity,
      },
    });
  }
  const availableCash = Number(snapshot.account.availableCash);
  if (Number.isFinite(availableCash) && availableCash < quantity * price) {
    throw new KisPaperRoundTripError("KIS 모의계좌 가용현금이 검증 주문금액보다 적습니다.", {
      code: "KIS_PAPER_ROUNDTRIP_INSUFFICIENT_CASH",
    });
  }
}

function assertSnapshotSafe(snapshot) {
  if (snapshot?.system?.killSwitch || snapshot?.system?.unknownResult) {
    throw new KisPaperRoundTripError("KIS 모의계좌가 킬 스위치 또는 주문 결과 불명 상태로 전환되었습니다.", {
      code: "KIS_PAPER_ROUNDTRIP_ACCOUNT_BLOCKED",
    });
  }
}

function assertAccepted(result, label) {
  if (result?.status !== "ACCEPTED") {
    throw new KisPaperRoundTripError(
      `${label} 주문이 ACCEPTED 상태가 아닙니다: ${result?.status ?? "응답 없음"}`,
      {
        code: `KIS_PAPER_ROUNDTRIP_${label === "매수" ? "BUY" : "SELL"}_NOT_ACCEPTED`,
        details: result ?? null,
      },
    );
  }
}

function commandStatus(snapshot, clientOrderId) {
  const commands = Array.isArray(snapshot?.account?.commands) ? snapshot.account.commands : [];
  return commands.find((command) => command.id === clientOrderId)?.response?.status ?? null;
}

function accountEvidence(snapshot) {
  return {
    timestamp: snapshot?.timestamp ?? null,
    quantity: positionQuantity(snapshot),
    sellableQuantity: finiteNumber(snapshot?.account?.sellableQuantity),
    availableCash: finiteNumber(snapshot?.account?.availableCash),
    equity: finiteNumber(snapshot?.account?.equity),
    averagePrice: finiteNumber(snapshot?.account?.position?.averagePrice),
    currentPrice: finiteNumber(snapshot?.account?.position?.currentPrice),
    unrealizedPnl: finiteNumber(snapshot?.account?.unrealizedPnl),
    openOrderCount: finiteNumber(snapshot?.account?.openOrderCount),
    commandCount: Array.isArray(snapshot?.account?.commands)
      ? snapshot.account.commands.length
      : 0,
  };
}

function orderEvidence(clientOrderId, result, snapshot) {
  return {
    clientOrderId,
    status: result?.status ?? null,
    replayed: Boolean(result?.replayed),
    orderNumber: result?.result?.orderNumber ?? null,
    orderOrganizationNumber: result?.result?.orderOrganizationNumber ?? null,
    orderTime: result?.result?.orderTime ?? null,
    journalStatus: commandStatus(snapshot, clientOrderId),
  };
}

function positionQuantity(snapshot) {
  const value = Number(snapshot?.account?.position?.quantity);
  return Number.isFinite(value) ? value : 0;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function createClientOrderId(operation, timestamp, idFactory) {
  return `verify-${operation}-${timestamp}-${String(idFactory()).replace(/[^A-Za-z0-9._:-]/g, "")}`
    .slice(0, 80);
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value ?? DEFAULT_BASE_URL));
  if (!/^https?:$/.test(url.protocol)) {
    throw new TypeError("PULSEHFT_BASE_URL은 http 또는 https URL이어야 합니다.");
  }
  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}

function safeError(error) {
  return {
    name: error?.name ?? "Error",
    code: error?.code ?? null,
    message: error instanceof Error ? error.message : String(error),
    details: error?.details ?? null,
  };
}

async function main() {
  if (process.env.PULSEHFT_VERIFY_KIS_PAPER !== "YES") {
    throw new KisPaperRoundTripError(
      "실제 KIS 모의주문 왕복 검증은 PULSEHFT_VERIFY_KIS_PAPER=YES를 명시해야 실행됩니다.",
      { code: "KIS_PAPER_ROUNDTRIP_OPT_IN_REQUIRED" },
    );
  }
  const report = await runKisPaperRoundTrip({
    baseUrl: process.env.PULSEHFT_BASE_URL ?? DEFAULT_BASE_URL,
    quantity: Number(process.env.PULSEHFT_VERIFY_QUANTITY ?? 1),
    timeoutMs: Number(process.env.PULSEHFT_VERIFY_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    pollIntervalMs: Number(process.env.PULSEHFT_VERIFY_POLL_MS ?? DEFAULT_POLL_INTERVAL_MS),
    allowOffHours: process.env.PULSEHFT_VERIFY_ALLOW_OFF_HOURS === "YES",
  });
  const reportPath = resolve(
    process.env.PULSEHFT_VERIFY_REPORT_PATH
      ?? ".pulsehft/kis-paper-roundtrip-latest.json",
  );
  mkdirSync(resolve(reportPath, ".."), { recursive: true });
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
