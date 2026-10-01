import {
  filterCommonStockCandidates,
  KisRecommendationDataClient,
  mergeRankingRows,
} from "./kisRecommendationDataClient.js";

export class KisRecommendationResearchDataClient extends KisRecommendationDataClient {
  async getUniverseSnapshot({ limit = 30, newlyListedWindowDays = 20 } = {}) {
    const normalizedLimit = integerInRange(limit, 10, 100, "limit");
    const volumeRows = await this.getVolumeRank();
    const fluctuationRows = await this.getFluctuationRank(normalizedLimit);
    const powerRows = await this.getVolumePowerRank();
    // 이 override는 부모 클래스(KisRecommendationDataClient)의 getUniverse()와
    // 별도로 유지되는 경로다 — 신규상장 조회(getRecentListings)가 부모에만
    // 추가되고 여기 전달이 빠지면, 실제로 쓰이는 이 경로(app.js가 생성하는
    // 클래스가 이쪽이다)에서는 isNewlyListed가 항상 false로 조용히 남는다
    // (2026-10-01, "신규 배지가 안 보인다"는 보고로 확인).
    const newlyListed = await this.getRecentListingsSafely(newlyListedWindowDays);
    const fetchedAt = this.now();
    const merged = mergeRankingRows({
      volumeRows,
      fluctuationRows,
      powerRows,
      limit: 100,
      fetchedAt,
      newlyListed,
    });
    const candidates = this.instrumentCatalog
      ? await filterCommonStockCandidates(
        merged,
        this.instrumentCatalog,
        normalizedLimit,
      )
      : merged.slice(0, normalizedLimit);
    return {
      fetchedAt,
      limit: normalizedLimit,
      rankings: {
        volume: structuredClone(volumeRows),
        fluctuation: structuredClone(fluctuationRows),
        volumePower: structuredClone(powerRows),
      },
      merged: structuredClone(merged),
      candidates: structuredClone(candidates),
    };
  }

  async getUniverse(options = {}) {
    const snapshot = await this.getUniverseSnapshot(options);
    return snapshot.candidates;
  }

  status() {
    return {
      ...super.status(),
      rawRankingSnapshotAvailable: true,
    };
  }
}

function integerInRange(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`${label}는 ${minimum} 이상 ${maximum} 이하의 정수여야 합니다.`);
  }
  return number;
}
