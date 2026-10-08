import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

// 자동매매의 당일 리스크 상태(재진입 금지 종목, 보유 시작 시각, 보유 중 고점)는
// 메모리에만 있어서 서버를 재시작하면 사라졌다. 2026-10-02 036930 매매 도중 두 번
// 재시작되면서 30분 보유 타이머와 고점이 초기화됐다. 파일에 남겨 재시작 뒤 되살린다.
// PaperAutoTradingConfigStore와 같은 원자적 쓰기(임시파일 뒤 rename)를 쓴다.
export class PaperAutoTraderStateStore {
  constructor(filePath) {
    if (!filePath) throw new TypeError("자동매매 상태 저장 파일 경로가 필요합니다.");
    this.filePath = filePath;
  }

  // 파일이 없거나 깨졌으면 null — 상태 복원은 편의 기능이라 기동을 막지 않는다.
  load() {
    if (!existsSync(this.filePath)) return null;
    try {
      const payload = JSON.parse(readFileSync(this.filePath, "utf8"));
      return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
    } catch {
      return null;
    }
  }

  save(state) {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      renameSync(temporaryPath, this.filePath);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  }
}
