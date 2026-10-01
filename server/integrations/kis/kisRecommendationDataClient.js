import { KisApiError } from "./kisProdReadOnlyClient.js";

const VOLUME_RANK = Object.freeze({
  path: "/uapi/domestic-stock/v1/quotations/volume-rank",
  trId: "FHPST01710000",
});
const FLUCTUATION_RANK = Object.freeze({
  path: "/uapi/domestic-stock/v1/ranking/fluctuation",
  trId: "FHPST01700000",
});
const VOLUME_POWER = Object.freeze({
  path: "/uapi/domestic-stock/v1/ranking/volume-power",
  trId: "FHPST01680000",
});
const ORDER_BOOK = Object.freeze({
  path: "/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn",
  trId: "FHKST01010200",
});
// 당일 분봉 전용 시장구분. 통합("UN")은 NXT 미상장 종목에서 빈 응답을 준다.
const MINUTE_BAR_MARKET = "J";
const MINUTE_BARS = Object.freeze({
  path: "/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice",
  trId: "FHKST03010200",
});
// 예탁원정보(공모주청약일정). 신규상장/공모주 당일 종목을 식별하는 유일한 소스로,
// 종목마스터에는 상장일이 없다.
const PUB_OFFER = Object.freeze({
  path: "/uapi/domestic-stock/v1/ksdinfo/pub-offer",
  trId: "HHKDB669108C0",
});

export class KisRecommendationDataClient {
  constructor({
    client,
    instrumentCatalog = null,
    now = Date.now,
    minimumIntervalMs = 1_000,
    rateLimitRetryCount = 2,
    rateLimitRetryBaseMs = 1_200,
    sleep = defaultSleep,
  }) {
    if (!client || typeof client.getAccessToken !== "function" || typeof client.request !== "function") {
      throw new TypeError("유효한 KIS 실전 시세 읽기 전용 client가 필요합니다.");
    }
    if (!client.config?.baseUrl || !client.config?.appKey || !client.config?.appSecret) {
      throw new TypeError("KIS client 설정이 올바르지 않습니다.");
    }
    if (typeof now !== "function") throw new TypeError("now는 함수여야 합니다.");
    if (!Number.isInteger(minimumIntervalMs) || minimumIntervalMs < 0 || minimumIntervalMs > 5_000) {
      throw new TypeError("minimumIntervalMs는 0~5000 정수여야 합니다.");
    }
    if (!Number.isInteger(rateLimitRetryCount) || rateLimitRetryCount < 0 || rateLimitRetryCount > 5) {
      throw new TypeError("rateLimitRetryCount는 0~5 정수여야 합니다.");
    }
    if (!Number.isInteger(rateLimitRetryBaseMs) || rateLimitRetryBaseMs < 250 || rateLimitRetryBaseMs > 10_000) {
      throw new TypeError("rateLimitRetryBaseMs는 250~10000 정수여야 합니다.");
    }
    if (typeof sleep !== "function") throw new TypeError("sleep은 함수여야 합니다.");
    if (instrumentCatalog !== null && typeof instrumentCatalog?.findBySymbol !== "function") {
      throw new TypeError("instrumentCatalog은 findBySymbol 함수를 제공해야 합니다.");
    }
    this.client = client;
    this.instrumentCatalog = instrumentCatalog;
    this.now = now;
    this.minimumIntervalMs = minimumIntervalMs;
    this.rateLimitRetryCount = rateLimitRetryCount;
    this.rateLimitRetryBaseMs = rateLimitRetryBaseMs;
    this.sleep = sleep;
    this.nextRequestAt = 0;
  }

  status() {
    return {
      enabled: true,
      mode: "PROD_READ_ONLY",
      rankingApiAvailable: true,
      orderBookApiAvailable: true,
      minuteBarsApiAvailable: true,
      instrumentMetadataFilterAvailable: Boolean(this.instrumentCatalog),
      realtimeConfirmationAvailable: false,
      newlyListedApiAvailable: true,
      minimumIntervalMs: this.minimumIntervalMs,
      rateLimitRetryCount: this.rateLimitRetryCount,
    };
  }

  async getUniverse({ limit = 30, newlyListedWindowDays = 20 } = {}) {
    const normalizedLimit = integerInRange(limit, 10, 100, "limit");
    const volumeRows = await this.getVolumeRank();
    const fluctuationRows = await this.getFluctuationRank(normalizedLimit);
    const powerRows = await this.getVolumePowerRank();
    const newlyListed = await this.getRecentListingsSafely(newlyListedWindowDays);
    const merged = mergeRankingRows({
      volumeRows,
      fluctuationRows,
      powerRows,
      limit: 100,
      fetchedAt: this.now(),
      newlyListed,
    });
    if (!this.instrumentCatalog) return merged.slice(0, normalizedLimit);
    return filterCommonStockCandidates(merged, this.instrumentCatalog, normalizedLimit);
  }

  // 예탁원 공모주청약일정 조회는 우선순위를 얹는 보조 신호일 뿐이라, 실패해도
  // 전체 추천 조회를 막지 않는다(빈 Map으로 조용히 대체).
  async getRecentListingsSafely(windowDays) {
    try {
      return await this.getRecentListings({ windowDays });
    } catch {
      return new Map();
    }
  }

  // 상장/등록일(list_dt)이 오늘 기준 windowDays 이내인 종목만 반환한다.
  // KIS 종목마스터에는 상장일이 없어 이 API가 유일한 소스다.
  async getRecentListings({ windowDays = 20 } = {}) {
    const days = integerInRange(windowDays, 0, 60, "windowDays");
    const today = currentKoreaDate(this.now());
    // F_DT/T_DT는 상장일(list_dt)이 아니라 청약 기준일(record_date)로 필터링된다.
    // 청약 마감부터 실제 상장까지 실측 10~14일 지연이 있어(2026-09-24 실측), 조회
    // 구간을 windowDays보다 넉넉히 넓혀야 상장 직후 종목을 놓치지 않는다. 실제
    // "최근 상장" 판정은 아래에서 list_dt 기준 daysSinceListing으로 다시 거른다.
    const SUBSCRIPTION_TO_LISTING_LAG_DAYS = 15;
    const from = shiftDate(today, -(days + SUBSCRIPTION_TO_LISTING_LAG_DAYS));
    const to = shiftDate(today, 5);
    const payload = await this.getJson(PUB_OFFER, {
      SHT_CD: "",
      CTS: "",
      F_DT: formatYyyymmdd(from),
      T_DT: formatYyyymmdd(to),
    }, "예탁원 공모주청약일정 조회");
    if (!Array.isArray(payload.output1)) {
      throw new KisApiError(
        "한국투자 공모주청약일정 응답에 output1 배열이 없습니다.",
        "KIS_PUB_OFFER_INVALID_RESPONSE",
      );
    }
    const todayValue = today.getTime();
    const listings = new Map();
    for (const row of payload.output1) {
      const symbol = textOrNull(row.sht_cd);
      const listDate = parseKisDate(row.list_dt);
      if (!symbol || !/^\d{6}$/.test(symbol) || !listDate) continue;
      const listedValue = listDate.getTime();
      if (listedValue > todayValue) continue; // 상장 예정 — 아직 매매 대상 아님
      const daysSinceListing = Math.round((todayValue - listedValue) / 86_400_000);
      if (daysSinceListing > days) continue;
      listings.set(symbol, {
        symbol,
        name: textOrNull(row.isin_name) ?? symbol,
        listingDate: formatIso(listDate),
        daysSinceListing,
      });
    }
    return listings;
  }

  // 공모주 청약 일정을 상장 전/후 가리지 않고 전부 돌려준다. getRecentListings()는
  // 매매 로직(이미 상장된 신규 종목 식별)용이라 상장 전 종목을 일부러 뺀다 —
  // 이건 반대로 "상장할 종목을 미리 보고 싶다"는 화면 전용 목록이라, 아직
  // list_dt가 안 잡힌(미정) 종목까지 청약기간·확정공모가·주관사와 함께 보여준다
  // (2026-10-01, "날짜도 보여야 하고 미리 알 수 있어야지" 요청으로 추가).
  async getPublicOfferingSchedule({ pastDays = 10, futureDays = 60 } = {}) {
    const past = integerInRange(pastDays, 0, 365, "pastDays");
    const future = integerInRange(futureDays, 0, 365, "futureDays");
    const today = currentKoreaDate(this.now());
    const from = shiftDate(today, -past);
    const to = shiftDate(today, future);
    const payload = await this.getJson(PUB_OFFER, {
      SHT_CD: "",
      CTS: "",
      F_DT: formatYyyymmdd(from),
      T_DT: formatYyyymmdd(to),
    }, "예탁원 공모주청약일정 조회");
    if (!Array.isArray(payload.output1)) {
      throw new KisApiError(
        "한국투자 공모주청약일정 응답에 output1 배열이 없습니다.",
        "KIS_PUB_OFFER_INVALID_RESPONSE",
      );
    }
    const items = payload.output1
      .map((row) => normalizePublicOfferingRow(row))
      .filter((item) => item !== null);
    // 청약 시작일이 이른 순으로 — 아직 청약일 자체가 비어 있으면(드묾) 맨 뒤로 보낸다.
    items.sort((a, b) => (a.subscriptionStart ?? "9999-99-99")
      .localeCompare(b.subscriptionStart ?? "9999-99-99"));
    return { fetchedAt: this.now(), items };
  }

  async getCandidateDetails({ symbol, market = "UN" }) {
    const normalizedSymbol = normalizeSymbol(symbol);
    // KIS REST 호출 제한을 보호하기 위해 후보 상세 조회는 순차 실행합니다.
    await this.waitForRateLimit();
    const quote = await this.client.getCurrentPrice({ symbol: normalizedSymbol, market });
    const orderBook = await this.getOrderBook({ symbol: normalizedSymbol, market });
    const minuteBars = await this.getMinuteBars({ symbol: normalizedSymbol, market });
    return {
      quote,
      orderBook,
      minuteBars,
      fetchedAt: this.now(),
    };
  }

  async getVolumeRank() {
    const payload = await this.getJson(VOLUME_RANK, {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_COND_SCR_DIV_CODE: "20171",
      FID_INPUT_ISCD: "0000",
      FID_DIV_CLS_CODE: "1",
      FID_BLNG_CLS_CODE: "3",
      FID_TRGT_CLS_CODE: "111111111",
      FID_TRGT_EXLS_CLS_CODE: "0000000000",
      FID_INPUT_PRICE_1: "1000",
      FID_INPUT_PRICE_2: "1000000",
      FID_VOL_CNT: "100000",
      FID_INPUT_DATE_1: "",
    }, "거래대금 순위 조회");
    return normalizeRankingOutput(payload, "KIS_VOLUME_RANK_INVALID_RESPONSE");
  }

  async getFluctuationRank(limit) {
    const payload = await this.getJson(FLUCTUATION_RANK, {
      fid_rsfl_rate2: "30",
      fid_cond_mrkt_div_code: "J",
      fid_cond_scr_div_code: "20170",
      fid_input_iscd: "0000",
      fid_rank_sort_cls_code: "0",
      fid_input_cnt_1: String(limit),
      fid_prc_cls_code: "0",
      fid_input_price_1: "1000",
      fid_input_price_2: "1000000",
      fid_vol_cnt: "100000",
      fid_trgt_cls_code: "0",
      fid_trgt_exls_cls_code: "0",
      fid_div_cls_code: "0",
      fid_rsfl_rate1: "-30",
    }, "등락률 순위 조회");
    return normalizeRankingOutput(payload, "KIS_FLUCTUATION_RANK_INVALID_RESPONSE");
  }

  async getVolumePowerRank() {
    const payload = await this.getJson(VOLUME_POWER, {
      fid_trgt_exls_cls_code: "0",
      fid_cond_mrkt_div_code: "J",
      fid_cond_scr_div_code: "20168",
      fid_input_iscd: "0000",
      fid_div_cls_code: "1",
      fid_input_price_1: "1000",
      fid_input_price_2: "1000000",
      fid_vol_cnt: "100000",
      fid_trgt_cls_code: "0",
    }, "체결강도 순위 조회");
    return normalizeRankingOutput(payload, "KIS_VOLUME_POWER_INVALID_RESPONSE");
  }

  async getOrderBook({ symbol, market = "UN" }) {
    const normalizedSymbol = normalizeSymbol(symbol);
    const payload = await this.getJson(ORDER_BOOK, {
      FID_COND_MRKT_DIV_CODE: normalizeMarket(market),
      FID_INPUT_ISCD: normalizedSymbol,
    }, "호가 조회");
    if (!isRecord(payload.output1)) {
      throw new KisApiError("한국투자 호가 응답에 output1 객체가 없습니다.", "KIS_ORDER_BOOK_INVALID_RESPONSE");
    }
    const output = payload.output1;
    const bestAsk = numberOrNull(output.askp1);
    const bestBid = numberOrNull(output.bidp1);
    const asks = Array.from({ length: 10 }, (_, index) => ({
      price: numberOrNull(output[`askp${index + 1}`]),
      size: numberOrNull(output[`askp_rsqn${index + 1}`]),
    })).filter((level) => level.price !== null && level.size !== null);
    const bids = Array.from({ length: 10 }, (_, index) => ({
      price: numberOrNull(output[`bidp${index + 1}`]),
      size: numberOrNull(output[`bidp_rsqn${index + 1}`]),
    })).filter((level) => level.price !== null && level.size !== null);
    return {
      symbol: normalizedSymbol,
      market: normalizeMarket(market),
      bestAsk,
      bestBid,
      totalAskSize: numberOrNull(output.total_askp_rsqn) ?? sum(asks.map((level) => level.size)),
      totalBidSize: numberOrNull(output.total_bidp_rsqn) ?? sum(bids.map((level) => level.size)),
      asks,
      bids,
      fetchedAt: this.now(),
    };
  }

  // 당일 분봉은 반드시 "J"(주식·ETF·ETN)로 조회한다. "UN"(KRX+NXT 통합)으로 조회하면
  // NXT 미상장 종목이 30행 전부 O=H=L=C=V=0인 빈 응답으로 돌아와, 평가 단계에서
  // "분봉 8개 미만"으로 조용히 차단된다(2026-09-10 확인).
  async getMinuteBars({ symbol, market = MINUTE_BAR_MARKET, hour = currentKoreaTime() }) {
    const normalizedSymbol = normalizeSymbol(symbol);
    const payload = await this.getJson(MINUTE_BARS, {
      FID_COND_MRKT_DIV_CODE: MINUTE_BAR_MARKET,
      FID_INPUT_ISCD: normalizedSymbol,
      FID_INPUT_HOUR_1: normalizeHour(hour),
      FID_PW_DATA_INCU_YN: "Y",
      FID_ETC_CLS_CODE: "",
    }, "당일 분봉 조회");
    if (!Array.isArray(payload.output2)) {
      throw new KisApiError("한국투자 당일 분봉 응답에 output2 배열이 없습니다.", "KIS_MINUTE_BARS_INVALID_RESPONSE");
    }
    return payload.output2.map((row) => ({
      time: textOrNull(row.stck_cntg_hour) ?? "",
      open: numberOrNull(row.stck_oprc),
      high: numberOrNull(row.stck_hgpr),
      low: numberOrNull(row.stck_lwpr),
      close: numberOrNull(row.stck_prpr),
      volume: numberOrNull(row.cntg_vol) ?? 0,
      accumulatedVolume: numberOrNull(row.acml_vol),
    })).filter((bar) => [bar.open, bar.high, bar.low, bar.close].every((value) => value !== null));
  }

  async getJson(definition, params, operation) {
    for (let attempt = 0; attempt <= this.rateLimitRetryCount; attempt += 1) {
      await this.waitForRateLimit();
      const accessToken = await this.client.getAccessToken();
      const url = new URL(definition.path, this.client.config.baseUrl);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
      const response = await this.client.request(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/plain",
          charset: "UTF-8",
          authorization: `Bearer ${accessToken}`,
          appkey: this.client.config.appKey,
          appsecret: this.client.config.appSecret,
          tr_id: definition.trId,
          custtype: "P",
        },
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new KisApiError(`한국투자 ${operation} 응답이 JSON이 아닙니다.`, "KIS_RECOMMENDATION_INVALID_JSON");
      }
      const providerCode = textOrNull(payload?.msg_cd);
      const providerMessage = redactText(
        firstText(payload?.msg1, payload?.message, payload?.error_description),
        [this.client.config.appKey, this.client.config.appSecret, accessToken],
      );
      const rateLimited = providerCode === "EGW00201";
      if (rateLimited && attempt < this.rateLimitRetryCount) {
        const retryDelayMs = this.rateLimitRetryBaseMs * (attempt + 1);
        await this.sleep(retryDelayMs);
        this.nextRequestAt = Math.max(this.nextRequestAt, this.now() + this.minimumIntervalMs);
        continue;
      }
      const providerDetail = [providerCode, providerMessage].filter(Boolean).join(" · ");
      if (!response.ok) {
        throw new KisApiError(
          `한국투자 ${operation} HTTP ${response.status} 실패${providerDetail ? ` (${providerDetail})` : ""}.`,
          "KIS_RECOMMENDATION_HTTP_ERROR",
          response.status,
        );
      }
      if (String(payload?.rt_cd ?? "") !== "0") {
        throw new KisApiError(
          `한국투자 ${operation} 요청이 거절되었습니다${providerDetail ? ` (${providerDetail})` : ""}.`,
          "KIS_RECOMMENDATION_REJECTED",
        );
      }
      return payload;
    }
    throw new KisApiError(
      `한국투자 ${operation} 호출 제한 재시도 횟수를 초과했습니다.`,
      "KIS_RECOMMENDATION_RATE_LIMIT_EXHAUSTED",
      503,
    );
  }

  async waitForRateLimit() {
    if (this.minimumIntervalMs <= 0) return;
    const current = this.now();
    const waitMs = Math.max(0, this.nextRequestAt - current);
    if (waitMs > 0) await this.sleep(waitMs);
    this.nextRequestAt = Math.max(this.now(), this.nextRequestAt) + this.minimumIntervalMs;
  }
}

export async function filterCommonStockCandidates(candidates, instrumentCatalog, limit = candidates.length) {
  if (!Array.isArray(candidates)) throw new TypeError("candidates는 배열이어야 합니다.");
  if (!instrumentCatalog || typeof instrumentCatalog.findBySymbol !== "function") {
    throw new TypeError("유효한 instrumentCatalog이 필요합니다.");
  }
  const normalizedLimit = integerInRange(limit, 1, 100, "limit");
  const filtered = [];
  for (const candidate of candidates) {
    let instrument;
    try {
      instrument = await instrumentCatalog.findBySymbol(candidate.symbol);
    } catch (error) {
      if (error?.code === "INSTRUMENT_NOT_FOUND") continue;
      throw error;
    }
    const commonStock = instrument.securityTypeCode === "ST" || instrument.securityType === "주식";
    if (!commonStock) continue;
    filtered.push({
      ...candidate,
      market: instrument.market ?? candidate.market,
      securityTypeCode: instrument.securityTypeCode ?? null,
      securityType: instrument.securityType ?? null,
    });
    if (filtered.length >= normalizedLimit) break;
  }
  return filtered;
}

export function mergeRankingRows({
  volumeRows,
  fluctuationRows,
  powerRows,
  limit,
  fetchedAt,
  newlyListed = new Map(),
}) {
  const candidates = new Map();
  addRows(candidates, volumeRows, "volumeRank");
  addRows(candidates, fluctuationRows, "fluctuationRank");
  addRows(candidates, powerRows, "volumePowerRank");
  const merged = [...candidates.values()].map((candidate) => {
    const listing = newlyListed.get(candidate.symbol) ?? null;
    const withListing = {
      ...candidate,
      isNewlyListed: Boolean(listing),
      daysSinceListing: listing?.daysSinceListing ?? null,
      listingDate: listing?.listingDate ?? null,
    };
    return {
      ...withListing,
      preliminaryScore: preliminaryScore(withListing),
      fetchedAt,
    };
  });
  return merged
    .filter((candidate) => isEligibleCandidate(candidate))
    .sort((a, b) => b.preliminaryScore - a.preliminaryScore || a.symbol.localeCompare(b.symbol))
    .slice(0, limit);
}

function addRows(target, rows, rankField) {
  if (!Array.isArray(rows)) return;
  rows.forEach((row, index) => {
    const normalized = normalizeRankingRow(row);
    if (!normalized.symbol) return;
    const previous = target.get(normalized.symbol) ?? {
      symbol: normalized.symbol,
      name: normalized.name ?? normalized.symbol,
      market: "KRX",
      volumeRank: null,
      fluctuationRank: null,
      volumePowerRank: null,
      currentPrice: null,
      changePercent: null,
      accumulatedVolume: 0,
      accumulatedTradingValue: 0,
      executionStrength: null,
      volumeTurnoverRate: null,
    };
    target.set(normalized.symbol, {
      ...previous,
      ...Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== null)),
      [rankField]: index + 1,
    });
  });
}

function normalizeRankingRow(row) {
  if (!isRecord(row)) return { symbol: null };
  return {
    symbol: firstText(row.mksc_shrn_iscd, row.stck_shrn_iscd, row.pdno, row.code),
    name: firstText(row.hts_kor_isnm, row.prdt_name, row.kor_isnm),
    currentPrice: firstNumber(row.stck_prpr, row.prpr),
    changePercent: firstNumber(row.prdy_ctrt, row.prdy_vrss_rt, row.rsfl_rate),
    accumulatedVolume: firstNumber(row.acml_vol, row.acml_tr_qty) ?? 0,
    accumulatedTradingValue: firstNumber(row.acml_tr_pbmn, row.acml_tr_amt) ?? 0,
    // cttr(체결강도)와 vol_tnrt(거래량회전율)는 완전히 다른 지표다. 예전에는
    // firstNumber(tday_rltv, vol_tnrt, cttr)로 묶어 읽어서, 거래량순위에서 온 종목은
    // 회전율이 체결강도 자리에 들어갔다(삼성전자 0.06 등). 회전율은 별도 필드로 분리하고
    // 체결강도는 진짜 체결강도 필드에서만 읽는다.
    executionStrength: firstNumber(row.cttr, row.tday_rltv),
    volumeTurnoverRate: firstNumber(row.vol_tnrt),
  };
}

function isEligibleCandidate(candidate) {
  if (!/^\d{6}$/.test(String(candidate.symbol ?? ""))) return false;
  const name = String(candidate.name ?? "").trim();
  if (!name) return false;
  if (/(?:스팩|SPAC|ETF|ETN|인버스|레버리지|선물)/i.test(name)) return false;
  if (/(?:우|우B|우C)$/.test(name)) return false;
  return true;
}

function preliminaryScore(candidate) {
  const rankScore = [candidate.volumeRank, candidate.fluctuationRank, candidate.volumePowerRank]
    .filter(Number.isInteger)
    .reduce((sumValue, rank) => sumValue + Math.max(0, 31 - rank), 0);
  const tradingValueScore = candidate.accumulatedTradingValue > 0
    ? Math.min(30, Math.log10(candidate.accumulatedTradingValue + 1) * 3)
    : 0;
  const powerScore = candidate.executionStrength !== null
    ? Math.min(20, Math.max(0, (candidate.executionStrength - 80) / 2))
    : 0;
  // 신규상장/공모주 당일 종목은 초반 상승폭이 커 우선순위를 높인다(2026-09-24).
  const newlyListedBoost = candidate.isNewlyListed ? 25 : 0;
  return rankScore + tradingValueScore + powerScore + newlyListedBoost;
}

function normalizeRankingOutput(payload, code) {
  if (!Array.isArray(payload.output)) {
    throw new KisApiError("한국투자 순위 응답에 output 배열이 없습니다.", code);
  }
  return payload.output;
}

function normalizeSymbol(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  if (!/^(?:\d{6}|Q\d{6})$/.test(symbol)) {
    throw new KisApiError("유효한 국내 종목코드가 필요합니다.", "KIS_RECOMMENDATION_INVALID_SYMBOL", 400);
  }
  return symbol;
}

function normalizeMarket(value) {
  const market = String(value ?? "UN").trim().toUpperCase();
  if (!["J", "NX", "UN"].includes(market)) {
    throw new KisApiError("market은 J, NX, UN 중 하나여야 합니다.", "KIS_RECOMMENDATION_INVALID_MARKET", 400);
  }
  return market;
}

function normalizeHour(value) {
  const hour = String(value ?? "").replaceAll(":", "").trim();
  if (!/^\d{6}$/.test(hour)) throw new KisApiError("분봉 조회시간은 HHMMSS 형식이어야 합니다.", "KIS_INVALID_HOUR", 400);
  return hour;
}

// 달력 날짜 비교/연산만 필요하므로 KST 자정을 UTC epoch에 고정해 표현한다
// (실제 타임존 인스턴트가 아니라 순수 달력값으로 다룬다). 테스트에서 시각을
// 고정할 수 있도록 인스턴스의 now()를 그대로 받는다(Date.now 직접 호출 금지).
function currentKoreaDate(nowMs) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "01";
  return new Date(Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day"))));
}

function shiftDate(date, deltaDays) {
  return new Date(date.getTime() + deltaDays * 86_400_000);
}

function formatYyyymmdd(date) {
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}`;
}

function formatIso(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

// KIS 예탁원정보 응답의 날짜 필드는 "YYYYMMDD" 또는 "YYYY/MM/DD" 형식이 섞여 온다.
function parseKisDate(value) {
  const digits = String(value ?? "").replaceAll(/\D/g, "");
  if (digits.length !== 8) return null;
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  if (!year || !month || !day) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

// 예탁원 공모주청약일정 한 행을 화면 표시용으로 정규화한다. list_dt는 상장일이
// 아직 확정되지 않은 종목(공모가 확정 전 등)에서는 빈 문자열로 온다 — null로
// 그대로 둬 "미정"을 화면에서 표현할 수 있게 한다.
function normalizePublicOfferingRow(row) {
  const symbol = textOrNull(row.sht_cd);
  if (!symbol || !/^\d{6}$/.test(symbol)) return null;
  const [subscriptionStartRaw, subscriptionEndRaw] = String(row.subscr_dt ?? "").split("~");
  return {
    symbol,
    name: textOrNull(row.isin_name) ?? symbol,
    fixedOfferPrice: numberOrNull(row.fix_subscr_pri),
    subscriptionStart: formatIsoOrNull(parseKisDate(subscriptionStartRaw)),
    subscriptionEnd: formatIsoOrNull(parseKisDate(subscriptionEndRaw)),
    listingDate: formatIsoOrNull(parseKisDate(row.list_dt)),
    leadManager: textOrNull(row.lead_mgr),
  };
}

function formatIsoOrNull(date) {
  return date ? formatIso(date) : null;
}

function currentKoreaTime() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("hour")}${get("minute")}${get("second")}`;
}

function integerInRange(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`${label}는 ${minimum} 이상 ${maximum} 이하의 정수여야 합니다.`);
  }
  return number;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(number) ? number : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const number = numberOrNull(value);
    if (number !== null) return number;
  }
  return null;
}

function textOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function redactText(value, secrets) {
  let text = textOrNull(value);
  if (!text) return null;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) {
      text = text.replaceAll(secret, "[REDACTED]");
    }
  }
  return text;
}

function firstText(...values) {
  for (const value of values) {
    const text = textOrNull(value);
    if (text) return text;
  }
  return null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sum(values) {
  return values.filter(Number.isFinite).reduce((total, value) => total + value, 0);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
