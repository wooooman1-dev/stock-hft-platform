import { evaluateRecommendationCandidate, screenPullbackShape } from "./recommendationEngine.js";
import { KisRealtimeMarketDataClient } from "../integrations/kis/kisRealtimeMarketDataClient.js";
import {
  evaluateRealtimeConfirmation,
  summarizeRealtimeStates,
} from "./realtimeConfirmationEngine.js";
import {
  normalizeRecommendationSettings,
  publicRecommendationSettings,
} from "./recommendationSettings.js";

// 15분봉 흐름은 종목당 여러 번 호출이 필요하다. 한 사이클에 새로 조회하는 종목 수 상한이다
// (캐시에 있는 종목은 호출 없이 쓰므로 여러 사이클에 걸쳐 점차 채워진다).
const MAX_FLOW_FETCHES_PER_CYCLE = 6;
// 모양 선별용 1분봉은 이 시간 안에는 다시 받지 않는다(사이클이 짧을 때 호출을 아낀다).
const SCREEN_CACHE_MS = 30_000;

export class RecommendationScanner {
  constructor({
    dataClient = null,
    disclosureClient = null,
    socialClient = null,
    realtimeClient = null,
    researchJournal = null,
    settings = {},
    now = Date.now,
    sleep = defaultSleep,
  } = {}) {
    if (typeof now !== "function") throw new TypeError("now는 함수여야 합니다.");
    if (typeof sleep !== "function") throw new TypeError("sleep은 함수여야 합니다.");
    if (realtimeClient !== null && (
      typeof realtimeClient.status !== "function"
      || typeof realtimeClient.snapshot !== "function"
      || typeof realtimeClient.watchSymbols !== "function"
    )) {
      throw new TypeError("realtimeClient는 status, snapshot, watchSymbols 함수를 제공해야 합니다.");
    }
    if (researchJournal !== null && (
      typeof researchJournal.status !== "function"
      || typeof researchJournal.recordScannerRefresh !== "function"
      || typeof researchJournal.recordRealtimeMarketData !== "function"
      || typeof researchJournal.recordConnectionStatus !== "function"
      || typeof researchJournal.recordError !== "function"
      || typeof researchJournal.recordStateTransition !== "function"
      || typeof researchJournal.stop !== "function"
    )) {
      throw new TypeError("researchJournal은 실시간 연구 기록 인터페이스를 제공해야 합니다.");
    }
    this.dataClient = dataClient;
    this.disclosureClient = disclosureClient;
    this.socialClient = socialClient;
    this.settings = normalizeRecommendationSettings(settings);
    this.realtimeClient = realtimeClient
      ?? createDefaultRealtimeClient(dataClient, this.settings.maxEnriched);
    this.researchJournal = researchJournal;
    this.now = now;
    this.sleep = sleep;
    this.inFlight = null;
    this.value = this.emptySnapshot();
    this.lastRealtimeStates = new Map();
    this.screenCache = new Map();
    this.realtimeListeners = null;
    this.bindRealtimeResearch();
  }

  // 화면에서 실시간 확인 문턱(예: 체결강도)을 조절할 수 있도록 런타임에 바꾼다.
  // 다음 attachRealtime() 호출부터(다음 폴링/재조회 시) 바로 적용된다.
  updateSettings(partial) {
    this.settings = normalizeRecommendationSettings({ ...this.settings, ...partial });
    return publicRecommendationSettings(this.settings);
  }

  status() {
    const dataStatus = this.dataClient?.status?.() ?? {
      enabled: false,
      mode: "DISABLED",
      rankingApiAvailable: false,
      orderBookApiAvailable: false,
      minuteBarsApiAvailable: false,
      realtimeConfirmationAvailable: false,
    };
    const realtimeStatus = this.realtimeClient?.status?.() ?? {
      enabled: false,
      state: "NOT_CONNECTED",
      connected: false,
      desiredSymbolCount: 0,
      activeSubscriptionCount: 0,
      automaticOrderConnected: false,
    };
    return {
      enabled: Boolean(this.dataClient),
      state: this.inFlight ? "REFRESHING" : this.value.state,
      generatedAt: this.value.generatedAt,
      expiresAt: this.value.expiresAt,
      candidateCount: this.value.candidates.length,
      dataSources: {
        kis: {
          ...dataStatus,
          realtimeConfirmationAvailable: Boolean(
            realtimeStatus.connected && realtimeStatus.activeSubscriptionCount > 0
          ),
        },
        realtime: realtimeStatus,
        research: this.researchJournal?.status?.() ?? disabledResearchStatus(),
        dart: this.disclosureClient?.status?.() ?? {
          enabled: false,
          state: "NOT_CONNECTED",
          role: "공시 위험 필터",
        },
        news: this.socialClient
          ? { ...this.socialClient.status(), role: "재료·추격 위험 보조" }
          : { enabled: false, state: "NOT_CONNECTED", role: "재료·추격 위험 보조" },
        community: this.socialClient
          ? { ...this.socialClient.status(), role: "과열 관심도 참고" }
          : { enabled: false, state: "NOT_CONNECTED", role: "과열 관심도 참고" },
      },
    };
  }

  async get({ refreshIfStale = true } = {}) {
    if (!this.dataClient) return this.snapshot();
    const stale = this.value.expiresAt === null || this.now() >= this.value.expiresAt;
    if (refreshIfStale && stale) await this.refresh();
    return this.snapshot();
  }

  async refresh({ force = false } = {}) {
    if (!this.dataClient) return this.snapshot();
    if (this.inFlight) return this.inFlight;
    const fresh = this.value.expiresAt !== null && this.now() < this.value.expiresAt;
    if (!force && fresh) return this.snapshot();
    this.inFlight = this.performRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  snapshot() {
    const candidates = this.value.candidates.map((candidate) => this.attachRealtime(
      candidate,
      "API_SNAPSHOT",
    ));
    return structuredClone({
      ...this.value,
      candidates,
      realtimeStateCounts: summarizeRealtimeStates(candidates),
      settings: publicRecommendationSettings(this.settings),
      status: this.status(),
    });
  }

  stop() {
    this.unbindRealtimeResearch();
    try {
      this.realtimeClient?.stop?.();
    } finally {
      this.researchJournal?.stop?.("recommendation scanner shutdown");
    }
  }

  async performRefresh() {
    const startedAt = this.now();
    const errors = [];
    let universeSnapshot;
    try {
      universeSnapshot = await collectUniverseSnapshot(
        this.dataClient,
        this.settings.maxUniverse,
        this.now,
        this.settings.newlyListedWindowDays,
      );
    } catch (error) {
      this.value = {
        ...this.value,
        state: "ERROR",
        lastAttemptAt: startedAt,
        errors: [safeError(error)],
      };
      return this.snapshot();
    }

    const universe = universeSnapshot.candidates;
    const candidates = [];
    const researchDetails = [];
    const preloadedBars = new Map();
    const enrichTargets = await this.selectEnrichTargets(universe, preloadedBars, errors);
    let disclosures = new Map();
    if (this.disclosureClient) {
      try {
        disclosures = await this.disclosureClient.getRecentDisclosures({
          stockCodes: enrichTargets
            .map((item) => item.symbol)
            .filter((symbol) => /^\d{6}$/.test(symbol)),
        });
      } catch (error) {
        errors.push({ source: "DART", ...safeError(error) });
      }
    }

    let flowFetches = 0;
    for (let index = 0; index < enrichTargets.length; index += 1) {
      const base = enrichTargets[index];
      try {
        const details = await this.dataClient.getCandidateDetails({
          symbol: base.symbol,
          market: "UN",
          minuteBars: preloadedBars.get(base.symbol),
        });
        const quote = details.quote ?? {};
        const orderBook = {
          ...(details.orderBook ?? {}),
          tickSize: quote.askUnit ?? details.orderBook?.tickSize ?? 1,
        };
        let social = emptySocialSignal();
        if (this.socialClient) {
          try {
            social = await this.socialClient.getSignals({
              symbol: base.symbol,
              name: base.name ?? quote.name ?? base.symbol,
            });
          } catch (error) {
            errors.push({ source: "NAVER", symbol: base.symbol, ...safeError(error) });
          }
        }
        const disclosure = disclosures.get(base.symbol)
          ?? emptyDisclosureSignal(Boolean(this.disclosureClient));
        const candidateInput = {
          ...base,
          name: base.name ?? quote.name ?? base.symbol,
          currentPrice: quote.currentPrice ?? base.currentPrice,
          previousClose: quote.basePrice,
          openPrice: quote.openPrice,
          highPrice: quote.highPrice,
          lowPrice: quote.lowPrice,
          upperLimitPrice: quote.upperLimitPrice,
          changePercent: quote.changePercent ?? base.changePercent,
          accumulatedVolume: quote.accumulatedVolume ?? base.accumulatedVolume,
          accumulatedTradingValue: quote.accumulatedTradingValue
            ?? base.accumulatedTradingValue,
          tradingHalted: quote.tradingHalted,
          // 체결강도는 순위 API가 아니라 현재가 응답을 신뢰한다(순위별로 필드가 달라 단위가 섞인다).
          executionStrength: quote.executionStrength ?? base.executionStrength ?? null,
          tickSize: quote.askUnit ?? 1,
          orderBook,
          minuteBars: details.minuteBars,
          fetchedAt: details.fetchedAt ?? quote.fetchedAt ?? this.now(),
          evaluatedAt: this.now(),
        };
        let evaluated = evaluateRecommendationCandidate(candidateInput, this.settings);
        // 흐름은 15분봉, 타이밍은 1분봉으로 본다(2026-10-07). 15분봉은 호출이 여러 번
        // 필요해서 1분봉 기준으로 가능성 있는 후보(점수 55 이상, 차단 아님)에만, 사이클당
        // 최대 MAX_FLOW_FETCHES_PER_CYCLE종목만 새로 조회한다(캐시 적중분은 호출 없음).
        // 조회 못 한 후보는 빈 배열로 평가해 "15분 흐름 확인 불가"로 WATCH에 둔다.
        if (typeof this.dataClient.getFlowBars === "function") {
          let flowBars = this.dataClient.getCachedFlowBars?.(base.symbol) ?? null;
          const promising = evaluated.stage !== "BLOCKED" && evaluated.score >= 55;
          if (flowBars === null && promising && flowFetches < MAX_FLOW_FETCHES_PER_CYCLE) {
            flowFetches += 1;
            try {
              flowBars = await this.dataClient.getFlowBars({ symbol: base.symbol });
            } catch (error) {
              errors.push({ source: "FLOW_BARS", symbol: base.symbol, ...safeError(error) });
            }
          }
          evaluated = evaluateRecommendationCandidate(
            { ...candidateInput, flowBars: flowBars ?? [] },
            this.settings,
          );
        }
        evaluated = attachAuxiliarySignals(evaluated, { disclosure, social });
        candidates.push(evaluated);
        researchDetails.push({
          symbol: base.symbol,
          base,
          quote,
          orderBook: details.orderBook ?? null,
          minuteBars: details.minuteBars ?? [],
          evaluated,
        });
      } catch (error) {
        const safe = { symbol: base.symbol, ...safeError(error) };
        errors.push(safe);
        researchDetails.push({
          symbol: base.symbol,
          base,
          error: safe,
        });
      }
      if (index < enrichTargets.length - 1 && this.settings.requestSpacingMs > 0) {
        await this.sleep(this.settings.requestSpacingMs);
      }
    }

    const generatedAt = this.now();
    candidates.sort((a, b) => {
      const stageOrder = stagePriority(b.stage) - stagePriority(a.stage);
      // 같은 단계라면 신규상장/공모주 당일 종목을 우선 노출한다(사용자 요청,
      // 2026-09-24) — 초반 상승폭이 커 진입 기회로서의 가치가 더 크다.
      const newlyListedOrder = Number(b.isNewlyListed) - Number(a.isNewlyListed);
      // 같은 단계 안에서는 눌림 후 재상승이 확인된 종목을 먼저 보여준다.
      const rerisingOrder = Number(b.pullbackRerise?.confirmed === true)
        - Number(a.pullbackRerise?.confirmed === true);
      return stageOrder
        || rerisingOrder
        || newlyListedOrder
        || b.score - a.score
        || b.accumulatedTradingValue - a.accumulatedTradingValue;
    });
    const ranked = candidates.map((candidate, index) => ({
      ...candidate,
      rank: index + 1,
    }));
    const previousSymbols = new Set(this.value.candidates.map((item) => item.symbol));
    const currentSymbols = new Set(ranked.map((item) => item.symbol));
    const executionBoundary = {
      automaticOrderConnected: false,
      actionableStages: [],
      realtimeEntryReadyIsOrderSignal: false,
      explanation: "추천과 ENTRY_READY는 분석 상태입니다. 별도 승인 전에는 KIS 모의·실전 주문으로 연결되지 않습니다.",
    };
    this.value = {
      state: ranked.length > 0 ? "READY" : "EMPTY",
      generatedAt,
      lastAttemptAt: startedAt,
      expiresAt: generatedAt + this.settings.cacheTtlMs,
      candidates: ranked,
      errors,
      universeCount: universe.length,
      enrichedCount: enrichTargets.length,
      executionBoundary,
    };

    safeResearchWrite(this.researchJournal, "recordScannerRefresh", {
      startedAt,
      generatedAt,
      universeSnapshot,
      details: researchDetails,
      candidates: ranked,
      errors,
      settings: publicRecommendationSettings(this.settings),
      executionBoundary,
    }, generatedAt);

    for (const symbol of previousSymbols) {
      if (currentSymbols.has(symbol)) continue;
      const previousState = this.lastRealtimeStates.get(symbol) ?? null;
      safeResearchWrite(this.researchJournal, "recordStateTransition", {
        symbol,
        fromState: previousState,
        toState: "DROPPED",
        source: "SCANNER_REFRESH",
        reasons: ["추천 정밀 분석 후보에서 제외됐습니다."],
        automaticOrderConnected: false,
      }, generatedAt);
      this.lastRealtimeStates.delete(symbol);
    }

    if (this.realtimeClient) {
      try {
        this.realtimeClient.watchSymbols(ranked.map((candidate) => ({
          symbol: candidate.symbol,
          venue: realtimeVenue(candidate.market),
        })));
      } catch (error) {
        const safe = { source: "KIS_WEBSOCKET", ...safeError(error) };
        errors.push(safe);
        safeResearchWrite(this.researchJournal, "recordError", safe, this.now());
      }
    }
    return this.snapshot();
  }

  attachRealtime(candidate, source) {
    let realtimeSnapshot = null;
    if (this.realtimeClient) {
      try {
        realtimeSnapshot = this.realtimeClient.snapshot(candidate.symbol);
      } catch {
        realtimeSnapshot = {
          connectionState: "DISCONNECTED",
          connected: false,
          orderBook: null,
          trade: null,
          latestAt: null,
        };
      }
    }
    const realtime = evaluateRealtimeConfirmation(candidate, realtimeSnapshot, {
      now: this.now(),
      staleAfterMs: realtimeSnapshot?.staleAfterMs,
      minimumExecutionStrength: this.settings.minimumExecutionStrength,
      maximumRealtimeChaseBps: this.settings.maximumRealtimeChaseBps,
    });
    this.trackRealtimeState(candidate, realtime, source);
    return {
      ...candidate,
      realtime,
      confirmation: {
        ...candidate.confirmation,
        required: realtime.state !== "ENTRY_READY",
        realtimeState: realtime.state,
        reason: realtime.reasons.join(" "),
        automaticOrderConnected: false,
      },
    };
  }

  trackRealtimeState(candidate, realtime, source) {
    if (!candidate?.symbol || !realtime?.state) return;
    const previousState = this.lastRealtimeStates.get(candidate.symbol) ?? null;
    if (previousState === realtime.state) return;
    safeResearchWrite(this.researchJournal, "recordStateTransition", {
      symbol: candidate.symbol,
      name: candidate.name,
      candidateStage: candidate.stage,
      score: candidate.score,
      fromState: previousState,
      toState: realtime.state,
      source,
      reasons: realtime.reasons,
      metrics: realtime.metrics,
      automaticOrderConnected: false,
    }, realtime.checkedAt ?? this.now());
    this.lastRealtimeStates.set(candidate.symbol, realtime.state);
  }

  // 정밀 분석 대상을 고른다. 순위 점수 상위 maxEnriched개만 쓰면 눌림 후 재상승 종목이
  // 순위 밖에 있을 때 영원히 못 보므로, 후보 maxScreened개 전체에 1분봉 1번만 받아 모양으로
  // 먼저 거른 뒤(모양 우선순위 → 같으면 순위순) 상위 maxEnriched개를 정밀 분석한다.
  // 받아둔 분봉은 정밀 분석에서 재사용해 호출을 아낀다.
  async selectEnrichTargets(universe, preloadedBars, errors) {
    const { maxEnriched, maxScreened } = this.settings;
    const screenCount = Math.min(universe.length, maxScreened);
    if (screenCount <= maxEnriched || typeof this.dataClient.getMinuteBars !== "function") {
      return universe.slice(0, maxEnriched);
    }
    const scored = [];
    for (let index = 0; index < screenCount; index += 1) {
      const base = universe[index];
      let priority = -1;
      try {
        const cached = this.screenCache.get(base.symbol);
        let rows = cached && this.now() - cached.at <= SCREEN_CACHE_MS ? cached.rows : null;
        if (rows === null) {
          rows = await this.dataClient.getMinuteBars({ symbol: base.symbol });
          this.screenCache.set(base.symbol, { at: this.now(), rows });
        }
        preloadedBars.set(base.symbol, rows);
        priority = screenPullbackShape(base, rows).priority;
      } catch (error) {
        errors.push({ source: "SCREEN", symbol: base.symbol, ...safeError(error) });
      }
      scored.push({ base, index, priority });
    }
    scored.sort((a, b) => b.priority - a.priority || a.index - b.index);
    return scored.slice(0, maxEnriched).map((item) => item.base);
  }

  bindRealtimeResearch() {
    if (!this.realtimeClient || typeof this.realtimeClient.on !== "function") return;
    const onMarketData = (snapshot) => {
      const timestamp = snapshot?.latestAt ?? this.now();
      safeResearchWrite(this.researchJournal, "recordRealtimeMarketData", {
        snapshot,
      }, timestamp);
      const candidate = this.value.candidates.find(
        (item) => item.symbol === snapshot?.symbol,
      );
      if (!candidate) return;
      const realtime = evaluateRealtimeConfirmation(candidate, snapshot, {
        now: this.now(),
        staleAfterMs: snapshot?.staleAfterMs,
        minimumExecutionStrength: this.settings.minimumExecutionStrength,
        maximumRealtimeChaseBps: this.settings.maximumRealtimeChaseBps,
      });
      this.trackRealtimeState(candidate, realtime, "MARKET_DATA");
    };
    const onStatus = (status) => {
      safeResearchWrite(
        this.researchJournal,
        "recordConnectionStatus",
        status,
        this.now(),
      );
      for (const candidate of this.value.candidates) {
        this.attachRealtime(candidate, "CONNECTION_STATUS");
      }
    };
    const onError = (error) => {
      safeResearchWrite(
        this.researchJournal,
        "recordError",
        error ?? { message: "KIS WebSocket 오류" },
        error?.at ?? this.now(),
      );
    };
    this.realtimeClient.on("marketData", onMarketData);
    this.realtimeClient.on("status", onStatus);
    this.realtimeClient.on("errorState", onError);
    this.realtimeListeners = { onMarketData, onStatus, onError };
  }

  unbindRealtimeResearch() {
    if (!this.realtimeListeners || typeof this.realtimeClient?.off !== "function") return;
    this.realtimeClient.off("marketData", this.realtimeListeners.onMarketData);
    this.realtimeClient.off("status", this.realtimeListeners.onStatus);
    this.realtimeClient.off("errorState", this.realtimeListeners.onError);
    this.realtimeListeners = null;
  }

  emptySnapshot() {
    return {
      state: this.dataClient ? "STALE" : "DISABLED",
      generatedAt: null,
      lastAttemptAt: null,
      expiresAt: null,
      candidates: [],
      errors: [],
      universeCount: 0,
      enrichedCount: 0,
      executionBoundary: {
        automaticOrderConnected: false,
        actionableStages: [],
        realtimeEntryReadyIsOrderSignal: false,
        explanation: "추천 목록은 분석용이며 자동주문과 연결되지 않습니다.",
      },
    };
  }
}

async function collectUniverseSnapshot(dataClient, limit, now, newlyListedWindowDays) {
  if (typeof dataClient.getUniverseSnapshot === "function") {
    const snapshot = await dataClient.getUniverseSnapshot({ limit, newlyListedWindowDays });
    if (!Array.isArray(snapshot?.candidates)) {
      throw new TypeError("getUniverseSnapshot 응답에 candidates 배열이 필요합니다.");
    }
    return snapshot;
  }
  const candidates = await dataClient.getUniverse({ limit, newlyListedWindowDays });
  return {
    fetchedAt: now(),
    limit,
    rankings: null,
    merged: structuredClone(candidates),
    candidates: structuredClone(candidates),
  };
}

function stagePriority(stage) {
  if (stage === "CONFIRMATION_REQUIRED") return 4;
  if (stage === "WATCH") return 3;
  if (stage === "LOW_PRIORITY") return 2;
  if (stage === "BLOCKED") return 1;
  return 0;
}

function safeError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "RECOMMENDATION_DATA_ERROR",
    message: error instanceof Error ? error.message : "추천 데이터 조회 오류",
  };
}

function safeResearchWrite(journal, method, payload, timestamp) {
  if (!journal || typeof journal[method] !== "function") return null;
  try {
    return journal[method](payload, timestamp);
  } catch {
    return null;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function attachAuxiliarySignals(candidate, { disclosure, social }) {
  const riskReasons = Array.isArray(disclosure?.riskReasons)
    ? disclosure.riskReasons
    : [];
  const blocked = disclosure?.riskLevel === "HIGH";
  return {
    ...candidate,
    stage: blocked ? "BLOCKED" : candidate.stage,
    score: blocked ? Math.min(49, candidate.score) : candidate.score,
    blockReasons: blocked
      ? [...new Set([
        ...(candidate.blockReasons ?? []),
        ...riskReasons.map((reason) => `중요 공시 확인: ${reason}`),
      ])]
      : candidate.blockReasons,
    auxiliary: {
      disclosure,
      news: social?.news ?? emptySocialSignal().news,
      community: social?.community ?? emptySocialSignal().community,
      policy: {
        newsAffectsScore: false,
        communityAffectsScore: false,
        disclosureHighRiskBlocksEntry: true,
      },
    },
  };
}

function emptyDisclosureSignal(enabled) {
  return {
    enabled,
    fetchedAt: null,
    count: 0,
    items: [],
    riskLevel: "NONE",
    riskReasons: [],
  };
}

function emptySocialSignal() {
  return {
    fetchedAt: null,
    news: { total: 0, returned: 0, items: [] },
    community: { total: 0, returned: 0, items: [] },
  };
}

function realtimeVenue(market) {
  const normalized = String(market ?? "").trim().toUpperCase();
  if (normalized === "NXT" || normalized === "NX") return "NXT";
  if (
    normalized === "UNIFIED"
    || normalized === "UN"
    || normalized === "INTEGRATED"
  ) {
    return "UNIFIED";
  }
  return "KRX";
}

function createDefaultRealtimeClient(dataClient, maxSymbols) {
  const config = dataClient?.client?.config;
  if (!config?.enabled || typeof globalThis.WebSocket !== "function") return null;
  try {
    return new KisRealtimeMarketDataClient({
      config,
      maxSymbols: Math.max(1, Math.min(20, Number(maxSymbols) || 8)),
    });
  } catch {
    return null;
  }
}

function disabledResearchStatus() {
  return {
    enabled: false,
    state: "DISABLED",
    eventCount: 0,
    queuedEvents: 0,
    bytesWritten: 0,
    droppedEvents: 0,
    automaticOrderConnected: false,
  };
}
