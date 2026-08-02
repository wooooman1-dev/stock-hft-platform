# 실시간 시장연구 기록·재생

## 목적

KIS WebSocket 호가·체결과 매수추천 상태를 append-only JSONL로 기록하고, 같은 데이터를 다시 재생해 실시간 조건의 상태 전이와 이후 가격 움직임을 확인합니다.

이 기능은 자동주문 기능이 아닙니다. 기록, 재생, 결과 요약 어디에서도 KIS 모의주문·실전주문·내부 자동전략을 호출하지 않습니다.

## 기록 범위

한 세션 파일에 다음 이벤트를 순서대로 저장합니다.

- `SESSION_STARTED`
- `SCANNER_REFRESH`
  - 거래대금 순위 원본
  - 등락률 순위 원본
  - 체결강도 순위 원본
  - 병합·보통주 필터 후보
  - 후보별 현재가
  - REST 10단계 호가
  - 당일 분봉
  - 점수, 유형, 근거, 차단 사유
- `REALTIME_CONNECTION_STATUS`
- `REALTIME_MARKET_DATA`
  - 실시간 호가 또는 체결이 반영된 종목 스냅샷
- `REALTIME_STATE_TRANSITION`
  - `SCANNED`
  - `WATCH`
  - `REALTIME_CONFIRMING`
  - `ENTRY_READY`
  - `BLOCKED`
  - `STALE`
  - `DISCONNECTED`
  - 연구 재생 전용 `DROPPED`
- `REALTIME_ERROR`
- `SESSION_STOPPED`

각 행에는 schemaVersion, eventId, sessionId, sequence, timestamp, type, payload가 들어갑니다.

## 저장 위치

기본 경로:

```text
.pulsehft/realtime-research/YYYYMMDD-HHMMSS-<session-id>.jsonl
```

`PULSEHFT_DATA_DIR`을 설정한 경우 해당 경로 아래의 `realtime-research` 폴더를 사용합니다.

API와 상태 응답에는 전체 로컬 경로를 노출하지 않고 파일명만 표시합니다.

## 기본 동작과 용량 제한

KIS 실전 시세 읽기 전용 추천 스캐너가 활성화되면 연구 기록도 기본 활성화됩니다.

기본값:

- flush 간격: 250ms
- 배치 크기: 250 이벤트
- 최대 대기열: 50,000 이벤트
- 세션 파일 최대 크기: 512MB

최대 크기에 도달하면 파일을 자동 삭제하거나 덮어쓰지 않고 `LIMIT_REACHED` 상태로 전환합니다. 대기열이 넘치거나 쓰기 오류가 발생하면 `droppedEvents`, `flushFailures`, `lastError`에 반영합니다.

## 환경변수

```dotenv
PULSEHFT_REALTIME_RECORDING_ENABLED=true
PULSEHFT_REALTIME_RECORDING_FLUSH_MS=250
PULSEHFT_REALTIME_RECORDING_BATCH_EVENTS=250
PULSEHFT_REALTIME_RECORDING_MAX_QUEUE=50000
PULSEHFT_REALTIME_RECORDING_MAX_FILE_BYTES=536870912
```

기록을 끄려면 다음 값을 명시합니다.

```dotenv
PULSEHFT_REALTIME_RECORDING_ENABLED=false
```

## 비밀정보 정책

다음 키는 기록 payload에서 제거합니다.

- Authorization
- App Key
- App Secret
- Access Token
- WebSocket approval key
- Client Secret
- 계좌번호

설정에 포함된 실제 App Key·App Secret 문자열이 일반 오류문에 섞여도 `[REDACTED]`로 치환합니다.

## 상태 확인 API

로컬 루프백에서만 조회합니다.

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/recommendations/research/status |
  ConvertTo-Json -Depth 20
```

주요 항목:

- `state`
- `fileName`
- `eventCount`
- `queuedEvents`
- `bytesWritten`
- `droppedEvents`
- `flushFailures`
- `typeCounts`
- `lastError`
- `automaticOrderConnected=false`

## 기록 검증

서버 실행 후 다른 PowerShell 창에서 실행합니다.

```powershell
cd F:\Project\stock-hft-platform

powershell -ExecutionPolicy Bypass `
  -File ".\scripts\verify-realtime-research.ps1"
```

사용자 지정 데이터 경로를 쓰는 경우:

```powershell
powershell -ExecutionPolicy Bypass `
  -File ".\scripts\verify-realtime-research.ps1" `
  -DataDir "D:\PulseHFTData"
```

검증 내용:

- 연구 기록 활성 상태
- 추천 강제 갱신 후 이벤트 수 증가
- `SCANNER_REFRESH` 기록
- JSONL 파일 생성과 flush
- 재생 엔진 실행
- 자동주문 분리
- 비밀정보 필드 비노출
- 이벤트 누락 0

## 재생 실행

최근 파일 선택:

```powershell
$file = Get-ChildItem ".\.pulsehft\realtime-research\*.jsonl" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
```

기본 재생:

```powershell
node .\scripts\replay-kis-realtime.js $file.FullName
```

결과 파일 저장:

```powershell
node .\scripts\replay-kis-realtime.js $file.FullName `
  --output=".\.pulsehft\replay-result.json"
```

임계값 비교:

```powershell
node .\scripts\replay-kis-realtime.js $file.FullName `
  --stale-ms=5000 `
  --max-spread-bps=20 `
  --min-book-imbalance=0.08 `
  --min-execution-strength=110 `
  --max-chase-bps=120 `
  --horizons=1000,5000,30000,60000
```

## 재생 결과

재생 결과에는 다음이 포함됩니다.

- 전체 이벤트 수와 기록 시간
- 종목 수
- 상태별 전이 횟수
- 종목별 `ENTRY_READY` 승격 횟수와 최초·최종 시각
- 후보 탈락 시각
- `ENTRY_READY` 당시 관찰 가격
- 1초·5초·30초·60초 뒤 첫 관찰 가격
- 각 구간 gross return bps
- 평균·중앙값·양수 비율·최소·최대 관찰 수익률

## 결과 해석 제한

재생 모델 이름은 다음과 같습니다.

```text
OBSERVATIONAL_NO_FILL_MODEL
```

이 결과는 다음 요소를 반영하지 않습니다.

- 주문 전송 지연
- 호가 대기열 순서
- 체결 가능 수량
- 호가 소진
- 부분체결
- 슬리피지
- 수수료
- 세금
- 정정·취소 지연

따라서 관찰 수익률이 양수여도 실제 체결 수익을 의미하지 않습니다. 충분한 장중 세션을 수집하고 TradingCostPolicy와 체결 모델을 결합하기 전에는 임계값을 수익성 있는 자동매매 규칙으로 확정하지 않습니다.
