import {
  appendFileSync,
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
  constructor(filePath, { maxOrderQuantity = 100, historyPath = null, now = Date.now } = {}) {
    if (!filePath) throw new TypeError("전략 설정 저장 파일 경로가 필요합니다.");
    if (typeof now !== "function") throw new TypeError("now는 함수여야 합니다.");
    this.filePath = filePath;
    this.maxOrderQuantity = maxOrderQuantity;
    this.historyPath = historyPath ?? `${filePath}.history.jsonl`;
    this.now = now;
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
    const previous = this.load();
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

    this.appendHistory({ previous, next: normalized });
    return normalized;
  }

  reset() {
    return this.save(DEFAULT_STRATEGY_SETTINGS);
  }

  appendHistory({ previous, next }) {
    const existing = this.history();
    const entry = {
      version: existing.length + 1,
      timestamp: this.now(),
      previous,
      next,
    };
    try {
      mkdirSync(dirname(this.historyPath), { recursive: true });
      appendFileSync(this.historyPath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (error) {
      throw new StrategySettingsError(
        `전략 설정 변경 이력을 기록할 수 없습니다: ${error instanceof Error ? error.message : String(error)}`,
        "STRATEGY_SETTINGS_HISTORY_WRITE_FAILED",
      );
    }
    return entry;
  }

  history() {
    if (!existsSync(this.historyPath)) return [];
    const raw = readFileSync(this.historyPath, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    return lines.map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new StrategySettingsError(
          `전략 설정 변경 이력 파일이 손상되었습니다(줄 ${index + 1}): ${error instanceof Error ? error.message : String(error)}`,
          "STRATEGY_SETTINGS_HISTORY_CORRUPT",
        );
      }
    });
  }

  restore(version) {
    const entries = this.history();
    const target = entries.find((entry) => entry.version === version);
    if (!target) {
      throw new StrategySettingsError(
        `전략 설정 이력에서 버전 ${version}을 찾을 수 없습니다.`,
        "STRATEGY_SETTINGS_VERSION_NOT_FOUND",
      );
    }
    return this.save(target.next);
  }
}
