import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ExecutionJournal } from "./domain/executionJournal.js";
import { InstrumentCatalog } from "./domain/instrumentCatalog.js";
import { KisMainWorkspace } from "./domain/kisMainWorkspace.js";
import { RecommendationScanner } from "./domain/recommendationScanner.js";
import { loadRecommendationSettings, publicRecommendationSettings } from "./domain/recommendationSettings.js";
import { createRealtimeResearchJournal } from "./domain/realtimeResearchJournal.js";
import { MarketRuntime } from "./domain/runtime.js";
import { loadPaperCostModel } from "./domain/paperTrader.js";
import { SelectedInstrumentStore } from "./domain/selectedInstrumentStore.js";
import { StrategySettingsStore } from "./domain/strategySettingsStore.js";
import {
  loadKisConfiguration,
  publicKisConfiguration,
} from "./integrations/kis/kisConfig.js";
import { KisProdReadOnlyClient } from "./integrations/kis/kisProdReadOnlyClient.js";
import { KisRecommendationResearchDataClient } from "./integrations/kis/kisRecommendationResearchDataClient.js";
import { KisRealtimeMarketDataClient } from "./integrations/kis/kisRealtimeMarketDataClient.js";
import { KisRealtimeSubscriptionCoordinator } from "./integrations/kis/kisRealtimeSubscriptionCoordinator.js";
import { createNaverApiHubClientFromEnv } from "./integrations/naver/naverApiHubClient.js";
import { createOpenDartClientFromEnv } from "./integrations/opendart/openDartClient.js";
import {
  loadKisPaperConfiguration,
  publicKisPaperConfiguration,
  KIS_PAPER_LIMIT_BOUNDS,
} from "./integrations/kis/kisPaperConfig.js";
import { KisPaperOrderService } from "./integrations/kis/kisPaperOrderService.js";
import { KisPaperAutoTrader } from "./domain/kisPaperAutoTrader.js";
import {
  assertTradeableConfiguration,
  loadAutoTradingSettings,
  normalizeAutoTradingSettings,
} from "./domain/autoTradingSettings.js";
import { PaperAutoTradingConfigStore } from "./domain/paperAutoTradingConfigStore.js";
import { KisPaperTradingClient } from "./integrations/kis/kisPaperTradingClient.js";
import {
  loadKisLiveConfiguration,
  publicKisLiveConfiguration,
} from "./integrations/kis/kisLiveConfig.js";
import { KisLiveOrderService } from "./integrations/kis/kisLiveOrderService.js";
import { KisLiveTradingClient } from "./integrations/kis/kisLiveTradingClient.js";
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

// 실행 저널은 순번 검증이 있어 파일 자체 형식은 지켜지지만, 같은 데이터 디렉터리를
// 두 서버 프로세스가 동시에 열면 각자 메모리 상 순번 카운터가 서로를 모른 채 같은
// 다음 번호를 내려써 저널이 뒤섞인다(2026-09-17: 껐다고 생각한 프로세스가 고아로
// 남아 새로 띄운 프로세스와 동시에 같은 저널에 써서 모의·실전 저널이 모두 손상됐다).
// 잠금 파일로 같은 데이터 디렉터리를 향한 두 번째 인스턴스의 기동 자체를 막는다.
// 강제 종료(taskkill, Stop-Process -Force)로 잠금 파일이 안 지워져도, 다음 기동 시
// 그 PID가 이미 죽어 있으면 자동으로 무시하고 새로 잠근다.
mkdirSync(dataDir, { recursive: true });
const lockFilePath = join(dataDir, "server.lock");

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

if (existsSync(lockFilePath)) {
  const previousPid = Number(readFileSync(lockFilePath, "utf8").trim());
  if (Number.isInteger(previousPid) && previousPid > 0 && previousPid !== process.pid && isProcessAlive(previousPid)) {
    console.error(
      `이미 PID ${previousPid}가 같은 데이터 디렉터리(${dataDir})로 실행 중입니다. ` +
        "두 프로세스가 동시에 실행 저널에 쓰면 파일이 손상됩니다. 기존 프로세스를 먼저 종료하세요.",
    );
    process.exit(1);
  }
}
writeFileSync(lockFilePath, String(process.pid), "utf8");

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

const sharedRealtimeClient = kisConfiguration.enabled
  && typeof globalThis.WebSocket === "function"
  ? new KisRealtimeMarketDataClient({
    config: kisConfiguration,
    maxSymbols: Math.max(2, Math.min(20, recommendationSettings.maxEnriched + 1)),
  })
  : null;
const realtimeCoordinator = sharedRealtimeClient
  ? new KisRealtimeSubscriptionCoordinator(sharedRealtimeClient)
  : null;
const recommendationRealtimeClient = realtimeCoordinator?.createView(
  "recommendations",
  { priority: 10 },
) ?? null;
const mainRealtimeClient = realtimeCoordinator?.createView(
  "main-workspace",
  { priority: 100 },
) ?? null;
// 자동매매가 실제로 들고 있는 포지션의 고점·반전은 추천 랭킹(우선순위 10)보다
// 먼저 지켜야 한다 — 랭킹 상위에서 밀려나도 보유 중인 동안은 구독이 유지돼야
// 실시간 트레일링 스톱(2026-09-23)이 계속 작동한다.
const heldPositionsRealtimeClient = realtimeCoordinator?.createView(
  "held-positions",
  { priority: 50 },
) ?? null;

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
  realtimeClient: recommendationRealtimeClient,
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

// 실전투자 카나리: 모의투자와 물리적으로 분리된 저널·토큰 파일을 사용해 두 계좌의 주문 상태가
// 섞이지 않게 한다(docs/KIS_LIVE_TRADING.md 참고). PULSEHFT_KIS_LIVE_MODE만으로는 주문을 낼 수
// 없고, PULSEHFT_KIS_LIVE_ORDER_ENABLED까지 별도로 켜야만 KisLiveOrderService가 생성된다.
const kisLiveConfiguration = loadKisLiveConfiguration(join(dataDir, "kis-live.json"));
const kisLiveJournal = new ExecutionJournal(join(dataDir, "execution-journal-live.jsonl"));
const kisLiveTokenStore = kisLiveConfiguration.enabled
  ? new KisTokenStore(join(dataDir, "kis-live-token.json"))
  : null;
const kisLiveClient = kisLiveConfiguration.enabled
  ? new KisLiveTradingClient({ config: kisLiveConfiguration, tokenStore: kisLiveTokenStore })
  : null;
if (kisLiveClient) kisLiveClient.status();

// 시세용과 주문용 자격정보를 공유하도록 명시적으로 옵트인한 상태는 조용히 넘어가지 않는다.
if (kisLiveConfiguration.enabled && kisLiveConfiguration.sharedQuoteCredential) {
  console.warn(
    "[KIS-LIVE] 경고: 실전 시세 조회와 실전 주문이 같은 App Key를 사용합니다 "
    + "(PULSEHFT_KIS_LIVE_ALLOW_SHARED_QUOTE_CREDENTIAL=true). "
    + "시세 조회 경로의 오류가 주문 권한을 가진 자격정보에 영향을 줄 수 있습니다.",
  );
  kisLiveJournal.append("LIVE_SHARED_QUOTE_CREDENTIAL_ENABLED", {
    processId: process.pid,
    orderEnabled: kisLiveConfiguration.orderEnabled,
    credentialSource: kisLiveConfiguration.credentialSource,
  });
}

const verificationApiEnabled = isVerificationApiEnabled(process.env);
const port = Number(process.env.PORT ?? 8787);

// 내부 시뮬레이터는 검증 API와 회귀 테스트를 위해 보존하지만 사용자 메인 화면에는 연결하지 않습니다.
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
    costModel: loadPaperCostModel(process.env),
  },
);

// 모의계좌 자동매매 설정·안전 한도는 화면에서 바꿔도 저장 파일이 없어 재시작하면
// .env 기본값으로 되돌아갔다(2026-09-17). 저장된 값이 있으면 그걸 우선한다.
const paperAutoTradingConfigStore = new PaperAutoTradingConfigStore(
  join(dataDir, "paper-auto-trading-config.json"),
);
const persistedPaperAutoTradingConfig = paperAutoTradingConfigStore.load();
if (persistedPaperAutoTradingConfig?.recommendationSettings) {
  recommendationScanner.updateSettings(persistedPaperAutoTradingConfig.recommendationSettings);
}

const kisPaperOrderService = kisPaperClient
  ? new KisPaperOrderService({
    client: kisPaperClient,
    journal: executionJournal,
    limits: kisPaperConfiguration.limits,
    onUnknownResult: () => runtime.setKillSwitch(true),
    costModel: loadPaperCostModel(process.env),
    performanceResetAt: persistedPaperAutoTradingConfig?.performanceResetAt ?? null,
  })
  : null;
if (kisPaperOrderService && persistedPaperAutoTradingConfig?.limits) {
  kisPaperOrderService.setLimits(persistedPaperAutoTradingConfig.limits);
}

// 모의계좌 자동매매(docs/AUTO_TRADING_PAPER_DESIGN.md). 실전 경로와 무관하며
// 기본은 꺼져 있다. 비용 모델은 내부 시뮬레이터·성과 지표와 같은 값을 공유한다.
const autoTradingCostModel = loadPaperCostModel(process.env);
const autoTradingSettings = persistedPaperAutoTradingConfig?.settings
  ? normalizeAutoTradingSettings(persistedPaperAutoTradingConfig.settings)
  : loadAutoTradingSettings(process.env);
// 익절 목표가 문턱과 고정비용의 합을 넘지 못하면 조용히 거래 0건이 된다. 기동 시점에 막는다.
assertTradeableConfiguration(autoTradingSettings, autoTradingCostModel);
const kisPaperAutoTrader = kisPaperOrderService
  ? new KisPaperAutoTrader({
    orderService: kisPaperOrderService,
    settings: autoTradingSettings,
    costModel: autoTradingCostModel,
    realtimeClient: heldPositionsRealtimeClient,
  })
  : null;
let autoTradingTimer = null;

const kisLiveOrderService = kisLiveClient && kisLiveConfiguration.orderEnabled
  ? new KisLiveOrderService({
    client: kisLiveClient,
    journal: kisLiveJournal,
    limits: kisLiveConfiguration.limits,
    onUnknownResult: () => runtime.setKillSwitch(true),
  })
  : null;

const mainWorkspace = new KisMainWorkspace({
  selection: selectedInstrument,
  quoteClient: kisClient,
  marketDataClient: recommendationDataClient,
  realtimeClient: mainRealtimeClient,
  paperService: kisPaperOrderService,
  paperClient: kisPaperClient,
  paperLimits: kisPaperConfiguration.limits,
  strategySettings,
});
mainWorkspace.start();

const startupSnapshot = mainWorkspace.snapshot();
executionJournal.append("SESSION_STARTED", {
  mode: "KIS_MARKET_WITH_PAPER",
  symbol: startupSnapshot.symbol,
  symbolName: startupSnapshot.symbolName,
  processId: process.pid,
  kisMode: kisConfiguration.mode,
  kisQuoteEnabled: kisConfiguration.enabled,
  kisRealtimeEnabled: Boolean(sharedRealtimeClient),
  kisPaperMode: kisPaperConfiguration.mode,
  kisPaperBalanceEnabled: Boolean(kisPaperClient),
  kisPaperOrderEnabled: Boolean(kisPaperOrderService),
  kisPaperAutomaticStrategyConnected: Boolean(kisPaperAutoTrader),
  kisPaperAutoTradingEnabled: Boolean(kisPaperAutoTrader?.settings.enabled),
  kisLiveMode: kisLiveConfiguration.mode,
  kisLiveBalanceEnabled: Boolean(kisLiveClient),
  kisLiveOrderEnabled: Boolean(kisLiveOrderService),
  kisLiveAutomaticStrategyConnected: false,
  internalSimulationConnectedToMainUi: false,
  instrumentSearchEnabled: true,
  recommendationScannerEnabled: Boolean(recommendationDataClient),
  recommendationDartEnabled: Boolean(openDartClient),
  recommendationNaverApiHubEnabled: Boolean(naverApiHubClient),
  recommendationResearchRecordingEnabled: realtimeResearchJournal.status().enabled,
  recommendationAutomaticOrderConnected: false,
});

const eventClients = new Set();
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
    ? {
      ...kisClient.status(),
      realtime: sharedRealtimeClient?.status?.() ?? null,
    }
    : {
      ...publicKisConfiguration(kisConfiguration),
      token: { state: "MISSING", expiresAt: null },
      quoteApiAvailable: false,
      realtime: null,
    };
}

function getKisHealthStatus() {
  const publicConfig = publicKisConfiguration(kisConfiguration);
  return {
    enabled: publicConfig.enabled,
    mode: publicConfig.mode,
    quoteApiAvailable: Boolean(kisClient),
    realtimeApiAvailable: Boolean(sharedRealtimeClient),
    realtimeConnected: sharedRealtimeClient?.status?.().connected ?? false,
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
        unknownCommands: [],
        trackedOrderNumbers: [],
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

// 실현손익 기록(BROKER_FILL_OBSERVED)에는 종목명이 없다 — 체결 당시 KIS 응답의 이름을
// 저널에 남기지 않았기 때문이다. 저널 스키마를 바꾸는 대신, 응답 시점에 종목 마스터로
// 이름을 찾아 붙인다. 이러면 이미 기록된 과거 거래도(마스터에 있는 한) 이름이 나온다.
// 종목을 못 찾아도(상장폐지 등) 조용히 이름 없이 코드만 보여주고 목록 자체는 막지 않는다.
// 종목 마스터 캐시가 없으면 findBySymbol이 KIS 서버로 실제 네트워크 요청을 건다
// (2026-09-17: 이게 느려지자 이 응답을 기다리던 화면의 다른 폴링(한도 조회 등)까지
// 전부 밀렸다). 그래서 각 조회를 500ms 안에 못 끝내면 이름 없이 넘어가도록 못박는다.
async function withTradeNames(performance) {
  const trades = performance?.trades?.recent;
  if (!Array.isArray(trades) || trades.length === 0) return performance;
  const symbols = [...new Set(trades.map((trade) => trade?.symbol).filter(Boolean))];
  const names = new Map();
  await Promise.all(symbols.map(async (symbol) => {
    try {
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 500));
      // 타임아웃으로 이겨도 findBySymbol 자체는 백그라운드에서 계속 진행되다 나중에
      // 거부될 수 있다 — 그 늦은 거부가 처리되지 않은 rejection으로 남지 않게 한다.
      const instrument = await Promise.race([
        instrumentCatalog.findBySymbol(symbol).catch(() => null),
        timeout,
      ]);
      if (instrument?.name) names.set(symbol, instrument.name);
    } catch {
      // 마스터에 없는 종목(상장폐지 등)은 이름 없이 코드만 표시한다.
    }
  }));
  return {
    ...performance,
    trades: {
      ...performance.trades,
      recent: trades.map((trade) => ({ ...trade, name: names.get(trade?.symbol) ?? null })),
    },
  };
}

function requireKisPaperAutoTrader(response) {
  if (kisPaperAutoTrader) return kisPaperAutoTrader;
  json(response, 503, {
    error: "한국투자 모의투자 주문 모드가 비활성화되어 자동매매를 쓸 수 없습니다.",
    code: "KIS_PAPER_AUTO_TRADING_DISABLED",
  });
  return null;
}

function requireKisPaperService(response) {
  if (kisPaperOrderService) return kisPaperOrderService;
  json(response, 503, {
    error: "한국투자 모의투자 주문 모드가 비활성화되어 있습니다.",
    code: "KIS_PAPER_DISABLED",
  });
  return null;
}

function getKisLiveStatus() {
  const publicConfig = publicKisLiveConfiguration(kisLiveConfiguration);
  return {
    ...(kisLiveClient
      ? kisLiveClient.status()
      : {
        ...publicConfig,
        token: { state: "MISSING", expiresAt: null },
      }),
    service: kisLiveOrderService
      ? kisLiveOrderService.status()
      : {
        killSwitch: false,
        unknownResult: false,
        unknownCommands: [],
        trackedOrderNumbers: [],
        commandCount: 0,
        todayCommandCount: 0,
        limits: publicConfig.limits,
        dailyRiskBaseline: null,
        automaticStrategyConnected: false,
      },
  };
}

function getKisLiveHealthStatus() {
  const publicConfig = publicKisLiveConfiguration(kisLiveConfiguration);
  return {
    enabled: publicConfig.enabled,
    mode: publicConfig.mode,
    balanceApiAvailable: Boolean(kisLiveClient),
    orderApiAvailable: Boolean(kisLiveOrderService),
    automaticStrategyConnected: false,
    killSwitch: kisLiveOrderService?.status().killSwitch ?? false,
    unknownResult: kisLiveOrderService?.status().unknownResult ?? false,
  };
}

function requireKisLiveService(response) {
  if (kisLiveOrderService) return kisLiveOrderService;
  json(response, 503, {
    error: "한국투자 실전투자 주문 모드가 비활성화되어 있습니다(PULSEHFT_KIS_LIVE_MODE, PULSEHFT_KIS_LIVE_ORDER_ENABLED 모두 필요).",
    code: "KIS_LIVE_DISABLED",
  });
  return null;
}

function broadcastSnapshot(snapshot) {
  const payload = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
  for (const client of eventClients) client.write(payload);
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
        mode: "KIS_MARKET_WITH_PAPER",
        clients: eventClients.size,
        main: mainWorkspace.snapshot().system,
        kis: getKisHealthStatus(),
        kisPaper: getKisPaperHealthStatus(),
        kisLive: getKisLiveHealthStatus(),
        instruments: instrumentCatalog.status(),
        recommendations: recommendationScanner.status(),
      });
    }
    if (request.method === "GET" && url.pathname === "/api/snapshot") {
      return json(response, 200, mainWorkspace.snapshot());
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.write(`event: snapshot\ndata: ${JSON.stringify(mainWorkspace.snapshot())}\n\n`);
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
      const selected = mainWorkspace.snapshot();
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
      const instrument = searchResult.results.find((item) => item.symbol === requestedSymbol);
      if (!instrument) {
        return json(response, 404, {
          error: "종목 마스터에서 요청한 종목을 찾을 수 없습니다.",
          code: "INSTRUMENT_NOT_FOUND",
        });
      }
      const quote = await kisClient.getCurrentPrice({ symbol: instrument.symbol, market: "UN" });
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
      // 내부 검증 런타임도 가능한 경우 동일 종목 메타데이터를 맞추되 메인 UI 데이터로 사용하지 않습니다.
      try { runtime.switchInstrument(selection); } catch { /* 내부 검증 상태는 KIS 메인 전환을 차단하지 않습니다. */ }
      const saved = selectedInstrumentStore.save(selection);
      const result = await mainWorkspace.switchInstrument(saved);
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
      return json(response, 200, await recommendationScanner.get({ refreshIfStale: true }));
    }
    if (request.method === "POST" && url.pathname === "/api/recommendations/refresh") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      return json(response, 200, await recommendationScanner.refresh({ force: true }));
    }
    // 화면 설정 폼이 후보 목록 전체(무거움)를 안 받고 설정값만 가볍게 읽도록 한다.
    if (request.method === "GET" && url.pathname === "/api/recommendations/settings") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      return json(response, 200, publicRecommendationSettings(recommendationScanner.settings));
    }
    // 실시간 확인 문턱(예: 체결강도)을 화면에서 조절할 수 있게 한다(2026-09-23).
    if (request.method === "POST" && url.pathname === "/api/recommendations/settings") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const body = await readJson(request);
      let next;
      try {
        next = recommendationScanner.updateSettings(body);
      } catch (error) {
        return json(response, error?.statusCode ?? 400, {
          error: error instanceof Error ? error.message : String(error),
          code: error?.code ?? "INVALID_RECOMMENDATION_SETTINGS",
        });
      }
      // 저장은 원본(계산된 costModel이 안 섞인) 설정만 한다 — 다음 기동 때 그대로
      // 다시 normalizeRecommendationSettings에 넣을 수 있어야 하기 때문이다.
      paperAutoTradingConfigStore.save({ recommendationSettings: recommendationScanner.settings });
      return json(response, 200, next);
    }
    if (request.method === "GET" && url.pathname === "/api/recommendations/research/status") {
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
    if (request.method === "POST" && url.pathname === "/api/kis/main/refresh") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      return json(response, 200, await mainWorkspace.refreshAll());
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
    // 모의계좌 안전 한도. 검증 중 표본 수집 속도를 조절하기 위해 런타임 변경을 허용한다.
    // 실전 한도는 이 경로를 제공하지 않는다.
    if (request.method === "GET" && url.pathname === "/api/kis/paper/limits") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const service = requireKisPaperService(response);
      if (!service) return;
      return json(response, 200, {
        limits: service.status().limits,
        bounds: KIS_PAPER_LIMIT_BOUNDS,
      });
    }
    if (request.method === "POST" && url.pathname === "/api/kis/paper/limits") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const service = requireKisPaperService(response);
      if (!service) return;
      const body = await readJson(request);
      try {
        const status = service.setLimits(body);
        paperAutoTradingConfigStore.save({ limits: status.limits });
        return json(response, 200, { limits: status.limits, bounds: KIS_PAPER_LIMIT_BOUNDS });
      } catch (error) {
        return json(response, error?.statusCode ?? 400, {
          error: error instanceof Error ? error.message : String(error),
          code: error?.code ?? "KIS_PAPER_LIMIT_INVALID",
        });
      }
    }
    // 자동매매 상태·설정. 실전 경로와 분리된 모의계좌 전용 엔드포인트다.
    if (request.method === "GET" && url.pathname === "/api/kis/paper/auto-trading") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const trader = requireKisPaperAutoTrader(response);
      if (!trader) return;
      return json(response, 200, trader.status());
    }
    if (request.method === "POST" && url.pathname === "/api/kis/paper/auto-trading") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const trader = requireKisPaperAutoTrader(response);
      if (!trader) return;
      const body = await readJson(request);
      let next;
      try {
        next = normalizeAutoTradingSettings({ ...trader.settings, ...body });
        assertTradeableConfiguration(next, autoTradingCostModel);
      } catch (error) {
        return json(response, error?.statusCode ?? 400, {
          error: error instanceof Error ? error.message : String(error),
          code: error?.code ?? "INVALID_AUTO_TRADING_SETTINGS",
        });
      }
      trader.updateSettings(next);
      paperAutoTradingConfigStore.save({ settings: next });
      restartAutoTradingTimer();
      return json(response, 200, trader.status());
    }
    if (request.method === "POST" && url.pathname === "/api/kis/paper/auto-trading/resume") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const trader = requireKisPaperAutoTrader(response);
      if (!trader) return;
      return json(response, 200, trader.clearHalt());
    }
    if (request.method === "GET" && url.pathname === "/api/kis/paper/performance") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const service = requireKisPaperService(response);
      if (!service) return;
      const recentLimit = url.searchParams.get("recent") === "all" ? 0 : undefined;
      return json(response, 200, await withTradeNames(service.getPerformance({ recentLimit })));
    }
    // 초기 오류가 있던 기간의 손익이 지금 성과를 계속 가려서 "오늘부터 새로
    // 보고 싶다"는 요청으로 추가했다(2026-09-23). 실행 저널은 그대로 두고
    // 성과 집계 시작 시각만 옮긴다 — resetAt을 생략하면 오늘 00:00(KST)부터,
    // resetAt: null을 명시하면 전체 이력 보기로 되돌린다.
    if (request.method === "POST" && url.pathname === "/api/kis/paper/performance/reset") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const service = requireKisPaperService(response);
      if (!service) return;
      const body = await readJson(request);
      const hasExplicitResetAt = Object.hasOwn(body, "resetAt");
      const resetAt = hasExplicitResetAt
        ? (body.resetAt === null ? null : Number(body.resetAt))
        : startOfKoreaDay(Date.now());
      if (resetAt !== null && !Number.isFinite(resetAt)) {
        return json(response, 400, { error: "resetAt은 타임스탬프(ms) 또는 null이어야 합니다." });
      }
      service.setPerformanceResetAt(resetAt);
      paperAutoTradingConfigStore.save({ performanceResetAt: resetAt });
      const recentLimit = url.searchParams.get("recent") === "all" ? 0 : undefined;
      return json(response, 200, await withTradeNames(service.getPerformance({ recentLimit })));
    }
    if (request.method === "GET" && url.pathname === "/api/kis/paper/fill-comparison") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const service = requireKisPaperService(response);
      if (!service) return;
      return json(response, 200, service.getFillComparison());
    }
    if (request.method === "POST" && url.pathname === "/api/kis/paper/orders") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const service = requireKisPaperService(response);
      if (!service) return;
      return json(response, 200, await mainWorkspace.submitOrder(await readJson(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/kis/paper/orders/revise") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const service = requireKisPaperService(response);
      if (!service) return;
      return json(response, 200, await mainWorkspace.reviseOrder(await readJson(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/kis/paper/orders/cancel") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const service = requireKisPaperService(response);
      if (!service) return;
      return json(response, 200, await mainWorkspace.cancelOrder(await readJson(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/kis/paper/orders/resolve-unknown") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const service = requireKisPaperService(response);
      if (!service) return;
      return json(response, 200, await mainWorkspace.resolveUnknownOrder(await readJson(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/kis/paper/kill-switch") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const service = requireKisPaperService(response);
      if (!service) return;
      const body = await readJson(request);
      if (typeof body.enabled !== "boolean") {
        return json(response, 400, { error: "enabled(boolean)가 필요합니다." });
      }
      if (body.enabled) runtime.setKillSwitch(true);
      return json(response, 200, mainWorkspace.setKillSwitch(body.enabled));
    }
    if (request.method === "GET" && url.pathname === "/api/kis/live/status") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      return json(response, 200, getKisLiveStatus());
    }
    if (request.method === "GET" && url.pathname === "/api/kis/live/balance") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const service = requireKisLiveService(response);
      if (!service) return;
      return json(response, 200, await service.getBalance());
    }
    if (request.method === "GET" && url.pathname === "/api/kis/live/performance") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const service = requireKisLiveService(response);
      if (!service) return;
      return json(response, 200, service.getPerformance());
    }
    if (request.method === "POST" && url.pathname === "/api/kis/live/orders") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const service = requireKisLiveService(response);
      if (!service) return;
      return json(response, 200, await service.submitOrder(await readJson(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/kis/live/orders/revise") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const service = requireKisLiveService(response);
      if (!service) return;
      return json(response, 200, await service.reviseOrder(await readJson(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/kis/live/orders/cancel") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const service = requireKisLiveService(response);
      if (!service) return;
      return json(response, 200, await service.cancelOrder(await readJson(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/kis/live/orders/resolve-unknown") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const service = requireKisLiveService(response);
      if (!service) return;
      return json(response, 200, await service.resolveUnknownResult(await readJson(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/kis/live/kill-switch") {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      const service = requireKisLiveService(response);
      if (!service) return;
      const body = await readJson(request);
      if (typeof body.enabled !== "boolean") {
        return json(response, 400, { error: "enabled(boolean)가 필요합니다." });
      }
      return json(response, 200, service.setKillSwitch(body.enabled));
    }
    if (url.pathname === "/api/kis" || url.pathname.startsWith("/api/kis/")) {
      if (rejectNonLoopbackKisRequest(request, response)) return;
      return json(response, 404, {
        error: "요청한 한국투자 API 경로가 없습니다.",
        code: "KIS_ROUTE_NOT_FOUND",
      });
    }

    // 아래 API는 사용자 메인 화면에 연결되지 않은 내부 시뮬레이터 검증용입니다.
    if (request.method === "GET" && url.pathname === "/api/strategy/settings") {
      return json(response, 200, runtime.getStrategySettings());
    }
    if (request.method === "PUT" && url.pathname === "/api/strategy/settings") {
      return json(response, 200, runtime.setStrategySettings(await readJson(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/strategy/settings/reset") {
      return json(response, 200, runtime.resetStrategySettings());
    }
    if (request.method === "GET" && url.pathname === "/api/strategy/settings/history") {
      return json(response, 200, { history: runtime.getStrategySettingsHistory() });
    }
    const restoreMatch = request.method === "POST"
      ? url.pathname.match(/^\/api\/strategy\/settings\/restore\/(\d+)$/)
      : null;
    if (restoreMatch) {
      return json(response, 200, runtime.restoreStrategySettings(Number(restoreMatch[1])));
    }
    if (request.method === "GET" && url.pathname === "/api/strategy/pending-approvals") {
      return json(response, 200, { pendingApprovals: runtime.getPendingApprovals() });
    }
    const approveMatch = request.method === "POST"
      ? url.pathname.match(/^\/api\/strategy\/pending-approvals\/([^/]+)\/approve$/)
      : null;
    if (approveMatch) {
      return json(response, 200, runtime.approveOrder(decodeURIComponent(approveMatch[1])));
    }
    const rejectMatch = request.method === "POST"
      ? url.pathname.match(/^\/api\/strategy\/pending-approvals\/([^/]+)\/reject$/)
      : null;
    if (rejectMatch) {
      return json(response, 200, runtime.rejectOrder(decodeURIComponent(rejectMatch[1])));
    }
    if (request.method === "POST" && url.pathname === "/api/verification/market-tick") {
      if (!verificationApiEnabled || !isLoopbackAddress(request.socket.remoteAddress)) {
        return json(response, 404, { error: "요청한 경로를 찾을 수 없습니다." });
      }
      return json(response, 200, applyVerificationMarketTick(runtime, await readJson(request)));
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
      return json(response, 200, runtime.cancelOrder(decodeURIComponent(cancelMatch[1])));
    }
    if (request.method === "POST" && url.pathname === "/api/system/kill-switch") {
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

mainWorkspace.on("snapshot", broadcastSnapshot);

const heartbeat = setInterval(() => {
  for (const client of eventClients) client.write(": heartbeat\n\n");
}, 15_000);

server.listen(port, "0.0.0.0", () => {
  console.log(`PulseHFT running at http://localhost:${port}`);
});

// 자동매매 평가 주기. 실제 주문은 KisPaperAutoTrader가 판단하며, 여기서는 입력만 모아 넘긴다.
// 장 시간 밖에서는 불필요한 잔고·시세 조회를 하지 않는다.
let autoTradingCycleInFlight = false;

async function runAutoTradingCycle() {
  if (!kisPaperAutoTrader || !kisPaperAutoTrader.settings.enabled) return;
  if (!isKoreaTradingWindow(Date.now())) return;
  // 한 주기가 평가 간격보다 오래 걸리면 다음 틱이 겹쳐 돌면서 같은 판단을 두 번 내린다.
  if (autoTradingCycleInFlight) return;
  autoTradingCycleInFlight = true;
  try {
    const [recommendations, balance] = await Promise.all([
      recommendationScanner.get({ refreshIfStale: true }),
      kisPaperOrderService.getBalance(),
    ]);
    await kisPaperAutoTrader.evaluate({
      candidates: recommendations?.candidates ?? [],
      balance,
    });
  } catch (error) {
    // 입력 수집 실패는 주문 실패와 다르다. 다음 주기에 다시 시도한다.
    kisPaperAutoTrader.record({
      action: "CYCLE_ERROR",
      at: Date.now(),
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    autoTradingCycleInFlight = false;
  }
}

function restartAutoTradingTimer() {
  if (autoTradingTimer) clearInterval(autoTradingTimer);
  autoTradingTimer = null;
  if (!kisPaperAutoTrader || !kisPaperAutoTrader.settings.enabled) return;
  autoTradingTimer = setInterval(() => {
    void runAutoTradingCycle();
  }, kisPaperAutoTrader.settings.evaluationIntervalMs);
  if (typeof autoTradingTimer.unref === "function") autoTradingTimer.unref();
}

// 모의투자(KIS 계정)는 정규장(09:00~15:30 KST)에만 주문을 받는다 — 08:00~20:00
// 확장 시간대(NXT 프리마켓·애프터마켓)로 자동 진입을 시도하면 "모의투자
// 장종료"로 거절되거나, 그 시간대에 몰린 응답 지연이 결과 불명(UNKNOWN)으로
// 이어져 킬 스위치가 켜진다 — 사람이 밤새 지켜보지 않으면 다음날 아침까지
// 전체 매매가 멈춘다(2026-09-17 저녁 18:46 킬 스위치가 다음날 09:42까지
// 안 풀려 그 사이 진입 기회를 전부 날린 사례로 확인). SOR/확장 시간대는
// 실전 계좌 쪽에만 유효하고, 모의투자 자동매매 진입 주기는 정규장으로 제한한다.
function isKoreaTradingWindow(timestamp) {
  const kst = new Date(Number(timestamp) + 9 * 60 * 60 * 1_000);
  const day = kst.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return minutes >= 9 * 60 && minutes <= 15 * 60 + 30;
}

// KST 날짜 경계의 00:00을 epoch ms로. KST는 UTC+9라 그 날짜 00:00 UTC에서 9시간을
// 빼면 된다(서머타임 없음).
function startOfKoreaDay(timestamp) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(Number(timestamp)));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)) - 9 * 60 * 60 * 1_000;
}

restartAutoTradingTimer();

let shuttingDown = false;
function shutdown() {
  // Ctrl+C를 여러 번 누르거나 SIGINT·SIGTERM이 겹쳐 들어와도 한 번만 처리한다.
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  if (autoTradingTimer) clearInterval(autoTradingTimer);
  mainWorkspace.stop();
  recommendationScanner.stop();
  kisPaperAutoTrader?.stop();
  realtimeCoordinator?.stop();
  runtime.stop();
  for (const client of eventClients) client.end();

  let exited = false;
  const finish = () => {
    if (exited) return;
    exited = true;
    clearTimeout(forceExitTimer);
    // 잠금 파일은 여기서 지운다 — stop()들은 타이머만 멈출 뿐 이미 시작된 저널
    // 쓰기가 끝났다는 보장이 없어서, 서버가 실제로 닫히는(또는 강제 종료
    // 유예시간이 끝나는) 이 시점까지 최대한 늦춘다. 너무 일찍 지우면 그 순간
    // 새 프로세스가 잠금이 없는 걸 보고 기동해 옛 프로세스와 동시에 같은
    // 저널에 써서 다시 손상된다(2026-09-17, 재발).
    try {
      unlinkSync(lockFilePath);
    } catch {
      // 이미 없거나 지울 수 없으면 다음 기동의 PID 생존 확인이 대신 처리한다.
    }
    process.exit(0);
  };

  // 브라우저가 유지하는 idle keep-alive 연결이 하나라도 남아 있으면
  // server.close()의 콜백이 영영 안 불려서 Ctrl+C를 눌러도 프로세스가 안
  // 죽는 문제가 있었다(2026-09-18: 사용자가 Ctrl+C로 껐다고 했는데 프로세스가
  // 계속 살아있었다). 열려 있는 소켓을 명시적으로 끊어서 close()가 실제로
  // 끝나게 하고, 그래도 안 끝나면 3초 뒤 강제 종료한다.
  server.close(finish);
  server.closeAllConnections?.();
  const forceExitTimer = setTimeout(finish, 3_000);
  forceExitTimer.unref?.();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
