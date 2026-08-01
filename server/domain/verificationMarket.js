export class VerificationMarketError extends Error {
  constructor(message, code = "INVALID_VERIFICATION_MARKET_TICK") {
    super(message);
    this.name = "VerificationMarketError";
    this.statusCode = 400;
    this.code = code;
  }
}

export function isVerificationApiEnabled(env = process.env) {
  return env?.PULSEHFT_ENABLE_VERIFICATION_API === "true";
}

export function isLoopbackAddress(address) {
  const value = String(address ?? "").toLowerCase();
  return value === "127.0.0.1"
    || value === "::1"
    || value === "::ffff:127.0.0.1";
}

export function createVerificationMarketTick(
  input,
  {
    tickSize,
    now = Date.now,
    candles = [],
  } = {},
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new VerificationMarketError("검증용 시장 틱은 JSON 객체여야 합니다.");
  }

  const allowedKeys = new Set(["lastPrice", "depthSize", "timestamp"]);
  const unknownKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new VerificationMarketError(`지원하지 않는 검증용 시장 필드: ${unknownKeys.join(", ")}`);
  }

  const normalizedTickSize = Number(tickSize);
  if (!Number.isFinite(normalizedTickSize) || normalizedTickSize <= 0) {
    throw new VerificationMarketError("검증용 시장 틱에는 유효한 호가 단위가 필요합니다.");
  }

  const lastPrice = Number(input.lastPrice);
  if (!Number.isFinite(lastPrice) || lastPrice <= normalizedTickSize) {
    throw new VerificationMarketError("검증용 현재가격은 호가 단위보다 큰 양수여야 합니다.");
  }
  if (Math.abs(lastPrice / normalizedTickSize - Math.round(lastPrice / normalizedTickSize)) > 1e-9) {
    throw new VerificationMarketError("검증용 현재가격은 호가 단위에 맞아야 합니다.");
  }

  const depthSize = input.depthSize === undefined ? 1_000 : Number(input.depthSize);
  if (!Number.isInteger(depthSize) || depthSize < 1 || depthSize > 1_000_000) {
    throw new VerificationMarketError("검증용 호가 잔량은 1 이상 1000000 이하의 정수여야 합니다.");
  }

  const timestamp = input.timestamp === undefined ? Number(now()) : Number(input.timestamp);
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new VerificationMarketError("검증용 시장 시각은 0 이상의 유효한 숫자여야 합니다.");
  }

  const bids = [];
  const asks = [];
  for (let index = 0; index < 10; index += 1) {
    const bidPrice = lastPrice - (index + 1) * normalizedTickSize;
    if (bidPrice > 0) bids.push({ price: bidPrice, size: depthSize });
    asks.push({
      price: lastPrice + (index + 1) * normalizedTickSize,
      size: depthSize,
    });
  }

  return {
    timestamp,
    lastPrice,
    book: { bids, asks },
    trades: [],
    candles: structuredClone(Array.isArray(candles) ? candles : []),
  };
}

export function applyVerificationMarketTick(runtime, input) {
  if (
    !runtime?.simulator
    || !runtime?.trader
    || typeof runtime.makeSnapshot !== "function"
    || typeof runtime.stop !== "function"
  ) {
    throw new TypeError("검증용 시장 틱을 적용할 유효한 런타임이 필요합니다.");
  }

  const tick = createVerificationMarketTick(input, {
    tickSize: runtime.simulator.tickSize,
    now: runtime.now,
    candles: runtime.snapshotValue?.candles,
  });

  runtime.stop();
  runtime.simulator.price = tick.lastPrice;
  runtime.snapshotValue = runtime.makeSnapshot(tick, 0);
  runtime.snapshotValue.system.verificationMode = true;
  runtime.snapshotValue.system.marketTimerPaused = true;
  runtime.trader.processOpenOrders({ book: tick.book, timestamp: tick.timestamp });
  runtime.snapshotValue.account = runtime.trader.snapshot(tick.lastPrice);
  runtime.syncPositionRisk(tick.lastPrice, tick.timestamp);
  runtime.maybeRunStrategy(tick.timestamp);
  runtime.snapshotValue.account = runtime.trader.snapshot(tick.lastPrice);
  runtime.syncPositionRisk(tick.lastPrice, tick.timestamp);
  runtime.emitSnapshot();
  return runtime.snapshot();
}
