export class PositionRiskTracker {
  constructor() {
    this.reset();
  }

  // openedAt: 이 포지션을 실제로 매수한 시각(주문 제출 시각)을 넘길 수 있다.
  // 안 넘기면(포지션이 재시작 전부터 있었거나 등) 지금 이 시각(timestamp)으로
  // 대신한다. 예전엔 항상 timestamp를 썼는데, 이건 "우리가 잔고에서 이 포지션을
  // 처음 확인한 시각"이라 KIS 잔고 반영이 늦어지면(전에 실측한 사례로 최대
  // 100초 가까이 걸림) 그만큼 "30분 보유" 카운트 시작이 밀렸다(2026-09-23,
  // 실제 매수보다 30분+반영지연만큼 더 들고 있게 됨). 아는 값이 있으면 그걸 쓴다.
  //
  // stopPrice: 손절선 가격. 넘기면 가격이 그 아래로 처음 내려온 시각(belowStopSince)을
  // 기록해 손절 유예(stopConfirmMs) 판단에 쓴다. 손절선 위로 올라오면 지운다.
  update({ quantity, lastPrice, timestamp, openedAt, stopPrice = null }) {
    const nextQuantity = Number(quantity);
    if (!Number.isInteger(nextQuantity) || nextQuantity < 0) {
      throw new TypeError("포지션 수량은 0 이상의 정수여야 합니다.");
    }

    if (nextQuantity === 0) {
      this.reset();
      return this.snapshot();
    }

    const price = Number(lastPrice);
    const time = Number(timestamp);
    if (!Number.isFinite(price) || price <= 0) {
      throw new TypeError("포지션 위험 추적에는 유효한 현재가격이 필요합니다.");
    }
    if (!Number.isFinite(time)) {
      throw new TypeError("포지션 위험 추적에는 유효한 시각이 필요합니다.");
    }

    if (this.quantity === 0) {
      // Number(null)이 0(유효한 값처럼 보임)이 되는 함정을 피한다 — null/undefined는
      // "모른다"는 뜻이지 "0"이 아니다. 이 실수를 kisPaperPerformance.js에서 이미
      // 한 번 했었다(resetAt).
      const knownOpenedAt = openedAt === null || openedAt === undefined ? NaN : Number(openedAt);
      this.openedAt = Number.isFinite(knownOpenedAt) ? knownOpenedAt : time;
      this.peakPrice = price;
      this.belowPeakSince = null;
      this.belowStopSince = null;
    } else {
      this.advancePeak(price, time);
    }
    this.advanceStop(price, time, stopPrice);
    this.quantity = nextQuantity;
    return this.snapshot();
  }

  // 5초 평가 주기 사이에도 실시간 틱으로 고점·하락지속시간을 갱신한다(2026-09-23,
  // "5초 사이에 순간적으로 튄 진짜 고점을 놓친다"는 지적에 따른 추가). 수량 정보가
  //없는 가벼운 갱신이라 포지션이 아직 없으면(quantity===0) 아무것도 안 한다 —
  // 수량 자체는 여전히 잔고 폴링(update)만 바꾼다.
  observeTick({ price, timestamp, stopPrice = null }) {
    if (this.quantity === 0) return this.snapshot();
    const p = Number(price);
    const t = Number(timestamp);
    if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(t)) return this.snapshot();
    this.advancePeak(p, t);
    this.advanceStop(p, t, stopPrice);
    return this.snapshot();
  }

  // 손절선 아래로 처음 내려온 시각만 기록하고, 다시 위로 올라오면 지운다.
  // stopPrice를 모르면(null) 손절 유예를 추적하지 않는다.
  advanceStop(price, timestamp, stopPrice) {
    const stop = stopPrice === null || stopPrice === undefined ? NaN : Number(stopPrice);
    if (!Number.isFinite(stop) || stop <= 0 || price > stop) {
      this.belowStopSince = null;
    } else if (this.belowStopSince === null) {
      this.belowStopSince = timestamp;
    }
  }

  // 재시작 전에 저장해 둔 고점으로 되살린다. 지금 고점보다 높을 때만 올린다.
  restorePeak(peakPrice, timestamp) {
    const peak = Number(peakPrice);
    if (this.quantity === 0 || !Number.isFinite(peak) || peak <= this.peakPrice) return this.snapshot();
    this.peakPrice = peak;
    // 고점 밑으로 언제 내려왔는지는 모른다 — 지금부터 다시 잰다.
    this.belowPeakSince = Number(timestamp);
    return this.snapshot();
  }

  // 신고점이면 고점을 갱신하고 "고점 밑으로 내려온 시각"을 지운다(계속 오르는 중).
  // 신고점이 아니면(고점과 같거나 낮으면) 처음 고점 밑으로 내려온 순간만 기록한다
  // — 그 뒤로 계속 낮아도 최초 시각을 그대로 유지해야 "얼마나 오래 밑에 있었는지"를
  // 잴 수 있다.
  advancePeak(price, timestamp) {
    if (price > this.peakPrice) {
      this.peakPrice = price;
      this.belowPeakSince = null;
    } else if (this.belowPeakSince === null) {
      this.belowPeakSince = timestamp;
    }
  }

  reset() {
    this.quantity = 0;
    this.openedAt = null;
    this.peakPrice = null;
    this.belowPeakSince = null;
    this.belowStopSince = null;
  }

  snapshot() {
    return {
      quantity: this.quantity,
      openedAt: this.openedAt,
      peakPrice: this.peakPrice,
      belowPeakSince: this.belowPeakSince,
      belowStopSince: this.belowStopSince,
    };
  }
}
