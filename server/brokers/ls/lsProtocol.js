const MARKET_TR_CODES = Object.freeze({
  KOSPI: Object.freeze({ book: "H1_", trade: "S3_" }),
  KOSDAQ: Object.freeze({ book: "HA_", trade: "K3_" }),
  UNIFIED: Object.freeze({ book: "UH1", trade: "US3" }),
});

function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const normalized = value.replaceAll(",", "").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getRealtimeTrCodes(market = "KOSPI") {
  const key = String(market).toUpperCase();
  const codes = MARKET_TR_CODES[key];
  if (!codes) throw new Error(`지원하지 않는 LS 시장 구분: ${market}`);
  return { ...codes };
}

export function buildRealtimeSubscription({ token, trCode, symbol, subscribe = true }) {
  if (!token) throw new Error("LS 실시간 구독에는 접근토큰이 필요합니다.");
  if (!trCode || !symbol) throw new Error("LS 실시간 구독에는 TR 코드와 종목코드가 필요합니다.");
  return {
    header: {
      token,
      tr_type: subscribe ? "3" : "4",
    },
    body: {
      tr_cd: trCode,
      tr_key: symbol,
    },
  };
}

export function normalizeRealtimeBook(message) {
  const header = message?.header ?? {};
  const body = message?.body ?? {};
  const asks = [];
  const bids = [];
  for (let level = 1; level <= 10; level += 1) {
    const askPrice = toNumber(body[`offerho${level}`]);
    const askSize = toNumber(body[`offerrem${level}`]);
    const bidPrice = toNumber(body[`bidho${level}`]);
    const bidSize = toNumber(body[`bidrem${level}`]);
    if (askPrice > 0) asks.push({ price: askPrice, size: Math.max(0, askSize) });
    if (bidPrice > 0) bids.push({ price: bidPrice, size: Math.max(0, bidSize) });
  }
  return {
    symbol: String(header.tr_key ?? body.shcode ?? ""),
    asks,
    bids,
  };
}

function normalizeAggressorSide(value) {
  const side = String(value ?? "").trim().toUpperCase();
  if (["+", "BUY", "B", "1"].includes(side)) return "BUY";
  if (["-", "SELL", "S", "2"].includes(side)) return "SELL";
  return "UNKNOWN";
}

export function normalizeRealtimeTrade(message, receivedAt = Date.now()) {
  const header = message?.header ?? {};
  const body = message?.body ?? {};
  return {
    symbol: String(body.shcode ?? header.tr_key ?? ""),
    timestamp: receivedAt,
    price: toNumber(body.price),
    size: Math.max(0, toNumber(body.cvolume ?? body.volume)),
    side: normalizeAggressorSide(body.cgubun),
    exchangeTime: String(body.chetime ?? ""),
  };
}

export function parseRealtimeMessage(raw) {
  if (typeof raw === "string") return JSON.parse(raw);
  if (raw instanceof ArrayBuffer) return JSON.parse(Buffer.from(raw).toString("utf8"));
  if (ArrayBuffer.isView(raw)) return JSON.parse(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8"));
  if (raw && typeof raw === "object") return raw;
  throw new Error("해석할 수 없는 LS 실시간 메시지입니다.");
}

export function normalizeT1101Response(response, receivedAt = Date.now()) {
  const body = response?.t1101OutBlock;
  if (!body || typeof body !== "object") throw new Error("LS t1101 응답에 t1101OutBlock이 없습니다.");
  const book = normalizeRealtimeBook({ header: {}, body });
  return {
    timestamp: receivedAt,
    lastPrice: toNumber(body.price),
    previousClose: toNumber(body.jnilclose),
    book: { asks: book.asks, bids: book.bids },
  };
}
