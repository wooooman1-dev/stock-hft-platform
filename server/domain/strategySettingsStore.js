import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_STRATEGY_SETTINGS,
  normalizeStrategySettings,
  StrategySettingsError,
} from "./strategySettings.js";

export class StrategySettingsStore {
  constructor(filePath, { maxOrderQuantity = 100 } = {}) {
    if (!filePath) throw new TypeError("전략 설정 저장 파일 경로가 필요합니다.");
    this.filePath = filePath;
    this.maxOrderQuantity = maxOrderQuantity;
  }

  load() {
    if (!existsSync(this.filePath)) {
      return normalizeStrategySettings(DEFAULT_STRATEGY_SETTINGS, {
        maxOrderQuantity: this.maxOrderQuantity,
      });
    }

    let payload;
    try {
      payload = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new StrategySettingsError(
        `전략 설정 파일을 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}`,
        "STRATEGY_SETTINGS_READ_FAILED",
      );
    }

    return normalizeStrategySettings(payload, {
      maxOrderQuantity: this.maxOrderQuantity,
    });
  }

  save(settings) {
    const normalized = normalizeStrategySettings(settings, {
      maxOrderQuantity: this.maxOrderQuantity,
    });
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;

    try {
      writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      renameSync(temporaryPath, this.filePath);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw new StrategySettingsError(
        `전략 설정을 저장할 수 없습니다: ${error instanceof Error ? error.message : String(error)}`,
        "STRATEGY_SETTINGS_WRITE_FAILED",
      );
    }

    return normalized;
  }

  reset() {
    return this.save(DEFAULT_STRATEGY_SETTINGS);
  }
}
