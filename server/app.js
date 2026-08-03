import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ExecutionJournal } from "./domain/executionJournal.js";
import { InstrumentCatalog } from "./domain/instrumentCatalog.js";
import { RecommendationScanner } from "./domain/recommendationScanner.js";
import { loadRecommendationSettings } from "./domain/recommendationSettings.js";
import { createRealtimeResearchJournal } from "./domain/realtimeResearchJournal.js";
import { MarketRuntime } from "./domain/runtime.js";
import { SelectedInstrumentStore } from "./domain/selectedInstrumentStore.js";
import { StrategySettingsStore } from "./domain/strategySettingsStore.js";
import {
  loadKisConfiguration,
  publicKisConfiguration,
} from "./integrations/kis/kisConfig.js";
import { KisProdReadOnlyClient } from "./integrations/kis/kisProdReadOnlyClient.js";
import { KisRecommendationResearchDataClient } from "./integrations/kis/kisRecommendationResearchDataClient.js";
import { createNaverApiHubClientFromEnv } from "./integrations/naver/naverApiHubClient.js";
import { createOpenDartClientFromEnv } from "./integrations/opendart/openDartClient.js";
import {
  loadKisPaperConfiguration,
  publicKisPaperConfiguration,
} from "./integrations/kis/kisPaperConfig.js";
import { KisPaperOrderService } from "./integrations/kis/kisPaperOrderService.js";
import { KisPaperTradingClient } from "./integrations/kis/kisPaperTradingClient.js";
import { KisTokenStore } from "./integrations/kis/kisTokenStore.js";
import {
  applyVerificationMarketTick,
  isLoopbackAddress,
  isVerificationApiEnabled,
} from "./domain/verificationMarket.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const publicDir = join(root, "public");
const dataDir = process.env.PULSEHFT_DATA_DIR
  ? resolve(process.env.PULSEHFT_DATA_DIR)
  : join(root, ".pulsehft");
const defaultInstrument = {
  symbol: process.env.DEFAULT_SYMBOL ?? "005930",
  symbolName: process.env.DEFAULT_SYMBOL_NAME ?? "삼성전자",
  market: null,
  securityType: null,
  initialPrice: Number(process.env.DEFAULT_PRICE ?? 70_000),
  previousClose: Number(process.env.DEFAULT_PRICE ?? 70_000),
  tickSize: 100,
  priceSource: "ENV_DEFAULT",
  quoteFetchedAt: null,
  selectedAt: null,
};
const strategySettingsStore = new StrategySettingsStore(join(dataDir, "strategy-settings.json"));
const strategySettings = strategySettingsStore.load();
const executionJournal = new ExecutionJournal(join(dataDir, "execution-journal.jsonl"));
const instrumentCatalog = new InstrumentCatalog(join(dataDir, "instrument-catalog.json"));
const selectedInstrumentStore = new SelectedInstrumentStore(join(dataDir, "selected-instrument.json"));
const selectedInstrument = selectedInstrumentStore.load() ?? defaultInstrument;

const kisConfiguration = loadKisConfiguration(join(dataDir, "kis-prod-read-only.json"));
const kisTokenStore = kisConfiguration.enabled
  ? new KisTokenStore(join(dataDir, "kis-prod-token.json"))
  : null;
const kisClient = kisConfiguration.enabled
  ? new KisProdReadOnlyClient({ config: kisConfiguration, tokenStore: kisTokenStore })
  : null;
if (kisClient) kisClient.status();
const recommendationSettings = loadRecommendationSettings(process.env);
const recommendationDataClient = kisClient
  ? new KisRecommendationResearchDataClient({
    client: kisClient,
    instrumentCatalog,
    minimumIntervalMs: recommendationSettings.requestSpacingMs,
  })
  : null;
const realtimeResearchJournal = createRealtimeResearchJournal({
  dataDir,
  enabled: recommendationDataClient ? undefined : false,
  config: kisConfiguration,
  env: process.env,
});
const openDartClient = createOpenDartClientFromEnv(process.env);
const naverApiHubClient = createNaverApiHubClientFromEnv(process.env);
const recommendationScanner = new RecommendationScanner({
  dataClient: recommendationDataClient,
  disclosureClient: openDartClient,
  socialClient: naverApiHubClient,
  researchJournal: realtimeResearchJournal,
  settings: recommendationSettings,
});
realtimeResearchJournal.recordSessionStarted({
  mode: "KIS_PROD_READ_ONLY_RESEARCH",
  kisMode: kisConfiguration.mode,
  recommendationScannerEnabled: Boolean(recommendationDataClient),
  realtimeRecordingEnabled: realtimeResearchJournal.status().enabled,
  maximumEnrichedCandidates: recommendationSettings.maxEnriched,
  automaticOrderConnected: false,
});

const kisPaperConfiguration = loadKisPaperConfiguration(join(dataDir, "kis-paper.json"));
const kisPaperTokenStore = kisPaperConfiguration.enabled
  ? new KisTokenStore(join(dataDir, "kis-paper-token.json"))
  : null;
const kisPaperClient = kisPaperConfiguration.enabled
  ? new KisPaperTradingClient({ config: kisPaperConfiguration, tokenStore: kisPaperTokenStore })
  : null;
if (kisPaperClient) kisPaperClient.status();

const verificationApiEnabled = isVerificationApiEnabled(process.env);
const port = Number(process.env.PORT ?? 8787);
const runtime = new MarketRuntime(
  selectedInstrument.symbol,
  selectedInstrument.symbolName,
  selectedInstrument.initialPrice,
  {
    strategySettings,
    strategySettingsStore,
    executionJournal,
    previousClose: selectedInstrument.previousClose,
    instrumentMarket: selectedInstrument.market,
    instrumentSecurityType: selectedInstrument.securityType,
    instrumentTickSize: selectedInstrument.tickSize,
    instrumentPriceSource: selectedInstrument.priceSource,
    instrumentQuoteFetchedAt: selectedInstrument.quoteFetchedAt,
    instrumentSelectedAt: selectedInstrument.selectedAt,
  },
);
const kisPaperOrderService = kisPaperClient
  ? new KisPaperOrderService({
    client: kisPaperClient,
    journal: executionJournal,
    limits: kisPaperConfiguration.limits,
    onUnknownResult: () => runtime.setKillSwitch(true),
  })
  : null;

const startupSnapshot = runtime.snapshot();
executionJournal.append("SESSION_STARTED", {
  mode: "SIMULATION",
  symbol: startupSnapshot.symbol,
  symbolName: startupSnapshot.symbolName,
  processId: process.pid,
  kisMode: kisConfiguration.mode,
  kisQuoteEnabled: kisConfiguration.enabled,
  kisPaperMode: kisPaperConfiguration.mode,
  kisPaperBalanceEnabled: Boolean(kisPaperClient),
  kisPaperOrderEnabled: Boolean(kisPaperOrderService),
  kisPaperAutomaticStrategyConnected: false,
  instrumentSearchEnabled: true,
  recommendationScannerEnabled: Boolean(recommendationDataClient),
  recommendationDartEnabled: Boolean(openDartClient),
  recommendationNaverApiHubEnabled: Boolean(naverApiHubClient),
  recommendationResearchRecordingEnabled: realtimeResearchJournal.status().enabled,
  recommendationAutomaticOrderConnected: false,
});
const eventClients = new Set();
runtime.start();

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("올바른 JSON 요청이 아닙니다.");
  }
}

function serveStatic(pathname, response) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  let filePath = join(publicDir, safePath);
  if (
    !filePath.startsWith(publicDir)
    || !existsSync(filePath)
    || statSync(filePath).isDirectory()
  ) {
    filePath = join(publicDir, "index.html");
  }
  response.writeHead(200, {
    "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
    "Cache-Control": filePath.endsWith("index.html")
      ? "no-store"
      : "public, max-age=300",
  });
  createReadStream(filePath).pipe(response);
}

function getKisStatus() {
  return kisClient
    ? kisClient.status()
    : {
      ...publicKisConfiguration(kisConfiguration),
      token: { state: "MISSING", expiresAt: null },
      quoteApiAvailable: false,
    };
}

function getKisHealthStatus() {
  const publicConfig = publicKisConfiguration(kisConfiguration);
  return {
    enabled: publicConfig.enabled,
    mode: publicConfig.mode,
    quoteApiAvailable: Boolean(kisClient),
    orderApiAvailable: false,
  };
}

function getKisPaperStatus() {
  const publicConfig = publicKisPaperConfiguration(kisPaperConfiguration);
  return {
    ...(kisPaperClient
      ? kisPaperClient.status()
      : {
        ...publicConfig,
        token: { state: "MISSING", expiresAt: null },
      }),
    service: kisPaperOrderService
      ? kisPaperOrderService.status()
      : {
        killSwitch: false,
        unknownResult: false,
        commandCount: 0,
        todayCommandCount: 0,
        limits: publicConfig.limits,
        dailyRiskBaseline: null,
        automaticStrategyConnected: false,
      },
  };
}

function getKisPaperHealthStatus() {
  const publicConfig = publicKisPaperConfiguration(kisPaperConfiguration);
  return {
    enabled: publicConfig.enabled,
    mode: publicConfig.mode,
    balanceApiAvailable: Boolean(kisPaperClient),
    orderApiAvailable: Boolean(kisPaperOrderService),
    automaticStrategyConnected: false,
    killSwitch: kisPaperOrderService?.status().killSwitch ?? false,
    unknownResult: kisPaperOrderService?.status().unknownResult ?? false,
  };
}

function rejectNonLoopbackKisRequest(request, response) {
  if (isLoopbackAddress(request.socket.remoteAddress)) return false;
  json(response, 404, { error: "요청한 경로를 찾을 수 없습니다." });
  return true;
}

function requireKisPaperService(response) {
  if (kisPaperOrderService) return kisPaperOrderService;
  json(response, 503, {
    error: "한국투자 모의투자 주문 모드가 비활성화되어 있습니다.",
    code: "KIS_PAPER_DISABLED",
  });
  return null;
}

const server = createServer(async (request, response) => {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, {
        status: "ok",
        mode: "SIMULATION",
        clients: eventClients.size,
        kis: getKisHealthStatus(),
        kisPaper: getKisPaperHealthStatus(),
        instruments: instrumentCatalog.status(),
        recommendations: recommendationScanner.status(),
      });
    }
    if (request.method === "GET" && url.pathname === "/api/snapshot") {
      return json(response, 200, runtime.snapshot());
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.write(`event: snapshot\ndata: ${JSON.stringify(runtime.snapshot())}\n\n`);
      eventClients.add(response);
      request.on("close", () => eventClients.delete(response));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/instruments/search") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      return json(response, 200, await instrumentCatalog.search(
        url.searchParams.get("q"),
        { limit: url.searchParams.get("limit") ?? 20 },
      ));
    }
    if (request.method === "GET" && url.pathname === "/api/instruments/status") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const selected = runtime.snapshot();
      return json(response, 200, {
        ...instrumentCatalog.status(),
        selected: {
          symbol: selected.symbol,
          symbolName: selected.symbolName,
          ...selected.instrument,
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/api/instruments/select") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      if (!kisClient) {
        return json(response, 503, {
          error: "종목 전환에는 한국투자 실전 시세 읽기 전용 연결이 필요합니다.",
          code: "KIS_DISABLED",
        });
      }
      const body = await readJson(request);
      const requestedSymbol = String(body.symbol ?? "").trim().toUpperCase();
      if (!/^(?:\d{6}|Q\d{6})$/.test(requestedSymbol)) {
        return json(response, 400, {
          error: "symbol은 6자리 종목코드 또는 Q로 시작하는 ETN 코드여야 합니다.",
          code: "INSTRUMENT_SELECT_INVALID_SYMBOL",
        });
      }
      const searchResult = await instrumentCatalog.search(requestedSymbol, { limit: 20 });
      const instrument = searchResult.results.find(
        (item) => item.symbol === requestedSymbol,
      );
      if (!instrument) {
        return json(response, 404, {
          error: "종목 마스터에서 요청한 종목을 찾을 수 없습니다.",
          code: "INSTRUMENT_NOT_FOUND",
        });
      }
      const quote = await kisClient.getCurrentPrice({
        symbol: instrument.symbol,
        market: "UN",
      });
      const currentPrice = Number(quote.currentPrice);
      const previousClose = Number(quote.basePrice);
      const tickSize = Number(quote.askUnit);
      if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
        return json(response, 502, {
          error: "한국투자 현재가 응답에 유효한 현재가가 없습니다.",
          code: "INSTRUMENT_QUOTE_PRICE_INVALID",
        });
      }
      const selection = {
        symbol: instrument.symbol,
        symbolName: instrument.name,
        market: instrument.market,
        securityType: instrument.securityType,
        initialPrice: currentPrice,
        previousClose: Number.isFinite(previousClose) && previousClose > 0
          ? previousClose
          : currentPrice,
        tickSize: Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 100,
        priceSource: "KIS_PROD_READ_ONLY",
        quoteFetchedAt: quote.fetchedAt,
      };
      const result = runtime.switchInstrument(selection, {
        persist: (next) => selectedInstrumentStore.save(next),
      });
      return json(response, 200, {
        changed: result.changed,
        selected: {
          symbol: instrument.symbol,
          symbolName: instrument.name,
          market: instrument.market,
          securityType: instrument.securityType,
        },
        quote: {
          currentPrice: quote.currentPrice,
          basePrice: quote.basePrice,
          askUnit: quote.askUnit,
          fetchedAt: quote.fetchedAt,
        },
        snapshot: result.snapshot,
      });
    }
    if (request.method === "GET" && url.pathname === "/api/recommendations") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      return json(
        response,
        200,
        await recommendationScanner.get({ refreshIfStale: true }),
      );
    }
    if (
      request.method === "POST"
      && url.pathname === "/api/recommendations/refresh"
    ) {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      return json(
        response,
        200,
        await recommendationScanner.refresh({ force: true }),
      );
    }
    if (
      request.method === "GET"
      && url.pathname === "/api/recommendations/research/status"
    ) {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      return json(response, 200, realtimeResearchJournal.status());
    }
    if (request.method === "GET" && url.pathname === "/api/kis/status") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      return json(response, 200, getKisStatus());
    }
    if (request.method === "GET" && url.pathname === "/api/kis/quote") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      if (!kisClient) {
        return json(response, 503, {
          error: "한국투자 실전 시세 전용 모드가 비활성화되어 있습니다.",
          code: "KIS_DISABLED",
        });
      }
      return json(response, 200, await kisClient.getCurrentPrice({
        symbol: url.searchParams.get("symbol"),
        market: url.searchParams.get("market") ?? "UN",
      }));
    }
    if (request.method === "GET" && url.pathname === "/api/kis/paper/status") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      return json(response, 200, getKisPaperStatus());
    }
    if (request.method === "GET" && url.pathname === "/api/kis/paper/balance") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const service = requireKisPaperService(response);
      if (!service) return;
      return json(response, 200, await service.getBalance());
    }
    if (request.method === "POST" && url.pathname === "/api/kis/paper/orders") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const service = requireKisPaperService(response);
      if (!service) return;
      return json(response, 200, await service.submitOrder(await readJson(request)));
    }
    if (
      request.method === "POST"
      && url.pathname === "/api/kis/paper/orders/revise"
    ) {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const service = requireKisPaperService(response);
      if (!service) return;
      return json(response, 200, await service.reviseOrder(await readJson(request)));
    }
    if (
      request.method === "POST"
      && url.pathname === "/api/kis/paper/orders/cancel"
    ) {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const service = requireKisPaperService(response);
      if (!service) return;
      return json(response, 200, await service.cancelOrder(await readJson(request)));
    }
    if (
      request.method === "POST"
      && url.pathname === "/api/kis/paper/kill-switch"
    ) {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const service = requireKisPaperService(response);
      if (!service) return;
      const body = await readJson(request);
      if (typeof body.enabled !== "boolean") {
        return json(response, 400, { error: "enabled(boolean)가 필요합니다." });
      }
      if (body.enabled) runtime.setKillSwitch(true);
      return json(response, 200, service.setKillSwitch(body.enabled));
    }
    if (url.pathname === "/api/kis" || url.pathname.startsWith("/api/kis/")) {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      return json(response, 404, {
        error: "요청한 한국투자 API 경로가 없습니다.",
        code: "KIS_ROUTE_NOT_FOUND",
      });
    }
    if (request.method === "GET" && url.pathname === "/api/strategy/settings") {
      return json(response, 200, runtime.getStrategySettings());
    }
    if (request.method === "PUT" && url.pathname === "/api/strategy/settings") {
      return json(response, 200, runtime.setStrategySettings(await readJson(request)));
    }
    if (
      request.method === "POST"
      && url.pathname === "/api/strategy/settings/reset"
    ) {
      return json(response, 200, runtime.resetStrategySettings());
    }
    if (
      request.method === "POST"
      && url.pathname === "/api/verification/market-tick"
    ) {
      if (!verificationApiEnabled || !isLoopbackAddress(request.socket.remoteAddress)) {
        return json(response, 404, { error: "요청한 경로를 찾을 수 없습니다." });
      }
      return json(
        response,
        200,
        applyVerificationMarketTick(runtime, await readJson(request)),
      );
    }
    if (request.method === "POST" && url.pathname === "/api/paper/orders") {
      const body = await readJson(request);
      return json(response, 200, runtime.submitOrder({
        side: body.side,
        type: body.type ?? "MARKET",
        quantity: body.quantity,
        limitPrice: body.limitPrice,
        clientOrderId: body.clientOrderId,
        source: "MANUAL",
      }));
    }
    const cancelMatch = request.method === "POST"
      ? url.pathname.match(/^\/api\/paper\/orders\/([^/]+)\/cancel$/)
      : null;
    if (cancelMatch) {
      return json(
        response,
        200,
        runtime.cancelOrder(decodeURIComponent(cancelMatch[1])),
      );
    }
    if (
      request.method === "POST"
      && url.pathname === "/api/system/kill-switch"
    ) {
      const body = await readJson(request);
      if (typeof body.enabled !== "boolean") {
        return json(response, 400, { error: "enabled(boolean)가 필요합니다." });
      }
      runtime.setKillSwitch(body.enabled);
      return json(response, 200, runtime.snapshot());
    }
    if (request.method === "POST" && url.pathname === "/api/strategy/auto") {
      const body = await readJson(request);
      if (typeof body.enabled !== "boolean") {
        return json(response, 400, { error: "enabled(boolean)가 필요합니다." });
      }
      runtime.setAutoPaperTrading(body.enabled);
      return json(response, 200, runtime.snapshot());
    }
    if (request.method === "POST" && url.pathname === "/api/paper/reset") {
      runtime.resetPaperAccount();
      return json(response, 200, runtime.snapshot());
    }
    if (request.method === "GET") return serveStatic(url.pathname, response);
    return json(response, 404, { error: "요청한 경로를 찾을 수 없습니다." });
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    return json(response, status, {
      error: error instanceof Error ? error.message : "서버 오류",
      code: error?.code ?? "SERVER_ERROR",
      ambiguous: Boolean(error?.ambiguous),
    });
  }
});

runtime.on("snapshot", (snapshot) => {
  const payload = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
  for (const client of eventClients) client.write(payload);
});

const heartbeat = setInterval(() => {
  for (const client of eventClients) client.write(": heartbeat\n\n");
}, 15_000);

server.listen(port, "0.0.0.0", () => {
  console.log(`PulseHFT running at http://localhost:${port}`);
});

function shutdown() {
  clearInterval(heartbeat);
  recommendationScanner.stop();
  runtime.stop();
  for (const client of eventClients) client.end();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
