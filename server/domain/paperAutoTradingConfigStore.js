import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

// 모의계좌 자동매매 설정과 안전 한도는 저장 없이 메모리에만 있었다. 재시작하면
// .env 기본값으로 되돌아가 사용자가 화면에서 바꾼 값이 사라졌다(2026-09-17).
// StrategySettingsStore와 같은 원자적 쓰기(임시파일 뒤 rename)로 파일에 남긴다.
export class PaperAutoTradingConfigStoreError extends Error {
  constructor(message, code = "PAPER_AUTO_TRADING_CONFIG_ERROR") {
    super(message);
    this.name = "PaperAutoTradingConfigStoreError";
    this.code = code;
    this.statusCode = 500;
  }
}

export class PaperAutoTradingConfigStore {
  constructor(filePath) {
    if (!filePath) throw new TypeError("모의계좌 자동매매 설정 저장 파일 경로가 필요합니다.");
    this.filePath = filePath;
  }

  // 파일이 없으면(첫 실행) null을 반환한다 — 호출하는 쪽이 .env 기본값을 쓴다.
  load() {
    if (!existsSync(this.filePath)) return null;
    let payload;
    try {
      payload = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new PaperAutoTradingConfigStoreError(
        `모의계좌 자동매매 설정 파일을 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}`,
        "PAPER_AUTO_TRADING_CONFIG_READ_FAILED",
      );
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new PaperAutoTradingConfigStoreError(
        "모의계좌 자동매매 설정 파일은 JSON 객체여야 합니다.",
        "PAPER_AUTO_TRADING_CONFIG_INVALID",
      );
    }
    return payload;
  }

  // settings/limits/performanceResetAt 중 넘어온 것만 병합해 저장한다(나머지
  // 저장되어 있는 값을 서로 덮어쓰지 않도록).
  save({ settings, limits, performanceResetAt } = {}) {
    const current = this.load() ?? {};
    const next = {
      ...(settings !== undefined ? { settings } : { settings: current.settings }),
      ...(limits !== undefined ? { limits } : { limits: current.limits }),
      ...(performanceResetAt !== undefined
        ? { performanceResetAt }
        : current.performanceResetAt !== undefined ? { performanceResetAt: current.performanceResetAt } : {}),
    };
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      renameSync(temporaryPath, this.filePath);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw new PaperAutoTradingConfigStoreError(
        `모의계좌 자동매매 설정을 저장할 수 없습니다: ${error instanceof Error ? error.message : String(error)}`,
        "PAPER_AUTO_TRADING_CONFIG_WRITE_FAILED",
      );
    }
    return next;
  }
}
