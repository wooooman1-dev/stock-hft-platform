import {
  filterCommonStockCandidates,
  KisRecommendationDataClient,
  mergeRankingRows,
} from "./kisRecommendationDataClient.js";

export class KisRecommendationResearchDataClient extends KisRecommendationDataClient {
  async getUniverseSnapshot({ limit = 30 } = {}) {
    const normalizedLimit = integerInRange(limit, 10, 100, "limit");
    const volumeRows = await this.getVolumeRank();
    const fluctuationRows = await this.getFluctuationRank(normalizedLimit);
    const powerRows = await this.getVolumePowerRank();
    const fetchedAt = this.now();
    const merged = mergeRankingRows({
      volumeRows,
      fluctuationRows,
      powerRows,
      limit: 100,
      fetchedAt,
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
