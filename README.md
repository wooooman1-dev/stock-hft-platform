# PulseHFT

실시간 호가·체결 기반 시장 미세구조 분석, 내부 모의체결, 선택형 한국투자증권 연동을 서버 중심 구조로 구현한 개발 버전입니다.

> 기본 실행은 `SIMULATION / INTERNAL PAPER ONLY`입니다. 선택적으로 한국투자 실전 현재가 조회 전용 `PROD_READ_ONLY` 또는 별도 모의투자 자격정보를 사용하는 `PAPER_TRADING`을 활성화할 수 있습니다. 실전 주문 기능은 구현되어 있지 않습니다.

## 포함 기능

- 10단계 호가·체결 시뮬레이션과 1초봉 차트
- 호가 불균형, 체결 흐름, 속도, 스프레드, 모멘텀, 변동성 분석
- 시장가 IOC, 지정가 GTC, 다단계·부분 체결, 잔량 취소
- `clientOrderId` 멱등성, 현금·매도수량 예약, 포지션·손익
- 모의 자동전략, 킬 스위치, 손절·익절·트레일링 스톱·최대 보유시간
- 전략 설정 영구 저장과 결정적 검증 시장 틱
- 주문·체결·계좌 초기화 append-only JSONL 실행 저널
- 한국투자 실전 REST 현재가 조회 전용 `PROD_READ_ONLY`
- KIS 공식 KOSPI·KOSDAQ 종목 마스터 기반 검색·메인 시뮬레이션 종목 전환
- 한국투자 모의계좌 잔고·매수·매도·정정·취소 `PAPER_TRADING`
- 모의계좌 주문 명령 선기록, 재시작 멱등 복원, `UNKNOWN_RESULT` 차단
- 주문수량·주문금액·일일 주문횟수·일일 손실 한도
- SSE 기반 실시간 대시보드
- 외부 패키지 의존성 없음

한국투자 모의주문은 기존 `MarketRuntime`과 자동전략에 연결되지 않았습니다. 현재 한국투자 주문은 로컬 API를 통한 명시적 수동 요청만 가능합니다.

## 내부 모의체결

- 시장가: 반대편 표시호가를 최우선 가격부터 소비하는 IOC
- 지정가: 가격이 교차하면 체결하고 잔량은 GTC 대기
- 전략 청산: 열린 주문을 먼저 취소한 뒤 전체 보유수량 시장가 IOC 제출
- 수수료·세금, 실제 주문 큐 순서, 숨은 유동성은 아직 미반영

세부 규칙은 `docs/PAPER_EXECUTION_MODEL.md`와 `docs/STRATEGY_SETTINGS.md`를 확인하세요.


## 국내 종목 검색과 메인 종목 전환

대시보드 상단의 `종목변경` 버튼 또는 `Ctrl+K`로 KOSPI·KOSDAQ 종목을 이름이나 코드로 검색합니다. 첫 검색 시 KIS 공식 종목 마스터 ZIP을 내려받아 `.pulsehft/instrument-catalog.json`에 캐시하며, 24시간이 지나면 자동 갱신합니다. 네트워크 갱신에 실패해도 기존 캐시가 있으면 `STALE` 상태로 검색을 계속합니다.

검색 결과를 선택하면 서버가 실전 `PROD_READ_ONLY` 현재가 API로 현재가·기준가·호가단위를 확인한 뒤 메인 `SIMULATION` 종목을 전환합니다. 상단 종목명, 차트, 호가, 체결, 분석 신호와 내부 모의주문 입력이 새 종목 기준으로 초기화되며 마지막 선택은 `.pulsehft/selected-instrument.json`에 저장되어 서버 재시작 후 복원됩니다.

단일 종목 내부 모의체결의 데이터 혼합을 막기 위해 다음 상태에서는 전환을 거절합니다.

- 내부 모의 자동전략이 켜져 있음
- 내부 모의계좌 보유수량이 남아 있음
- 대기 주문이 남아 있음
- 이전 종목의 주문 내역이 남아 있음 — 화면의 내부 모의계좌 `초기화` 후 전환

이 전환은 PulseHFT 내부 `SIMULATION`에만 적용됩니다. 한국투자 모의계좌 잔고와 실제 모의주문은 자동으로 변경하거나 제출하지 않습니다.

## 한국투자 실전 시세 전용

실전 연동은 계좌번호 없이 현재가만 조회합니다.

```dotenv
PULSEHFT_KIS_MODE=PROD_READ_ONLY
PULSEHFT_KIS_APP_KEY="실전 APP KEY"
PULSEHFT_KIS_APP_SECRET="실전 APP SECRET"
```

```powershell
npm run start:kis:prod-read-only
```

```text
GET /api/kis/status
GET /api/kis/quote?symbol=005930&market=UN
```

자세한 내용은 `docs/KIS_PROD_READ_ONLY.md`를 확인하세요.

## 한국투자 모의투자 주문

모의투자는 실전 키와 다른 App Key·App Secret, 모의계좌가 필요합니다. 권장 설정 방식은 비밀값을 `.env`에 직접 편집하지 않고 보안 입력 스크립트를 사용하는 것입니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\configure-kis-paper-trading.ps1
& .\.pulsehft\start-kis-paper-trading.ps1
```

로컬 전용 API:

```text
GET  /api/kis/paper/status
GET  /api/kis/paper/balance
POST /api/kis/paper/orders
POST /api/kis/paper/orders/revise
POST /api/kis/paper/orders/cancel
POST /api/kis/paper/kill-switch
```

실전 주문은 존재하지 않으며 한국투자 모의주문은 자동전략에 연결되지 않습니다. 상세 설정, 요청 형식, 수동 검증 절차는 `docs/KIS_PAPER_TRADING.md`를 확인하세요.

## 실행 저널

```text
.pulsehft/execution-journal.jsonl
```

파일은 JSONL append-only이며 시작 시 전체 JSON·스키마·연속 sequence를 검사합니다. 각 append 뒤 `fsync`합니다. 손상 파일은 자동 덮어쓰지 않습니다.

내부 모의체결 이벤트 외에 한국투자 모의투자에서는 다음 이벤트를 기록합니다.

```text
BROKER_RISK_BASELINE
BROKER_ORDER_COMMAND
BROKER_ORDER_RESULT
BROKER_ORDER_UNKNOWN
```

주문 명령 기록에 실패하면 증권사 요청을 보내지 않습니다. 증권사 요청 후 결과를 확정할 수 없거나 결과 저널 기록에 실패하면 `UNKNOWN_RESULT`와 킬 스위치로 전환하고 자동 재시도하지 않습니다. API 키·시크릿·토큰·계좌번호 원문은 저널과 API 응답에 기록하지 않습니다.

## 실행과 검증

Node.js 22 이상만 필요하며 `npm install`은 필요하지 않습니다.

```powershell
npm start
npm run dev
npm run check
```

브라우저: `http://localhost:8787`

## 전체 API

```text
GET  /health
GET  /api/snapshot
GET  /api/events
GET  /api/instruments/status
GET  /api/instruments/search?q=삼성전자&limit=20
POST /api/instruments/select
GET  /api/kis/status
GET  /api/kis/quote?symbol=005930&market=UN
GET  /api/kis/paper/status
GET  /api/kis/paper/balance
POST /api/kis/paper/orders
POST /api/kis/paper/orders/revise
POST /api/kis/paper/orders/cancel
POST /api/kis/paper/kill-switch
GET  /api/strategy/settings
PUT  /api/strategy/settings
POST /api/strategy/settings/reset
POST /api/paper/orders
POST /api/paper/orders/:orderId/cancel
POST /api/paper/reset
POST /api/strategy/auto
POST /api/system/kill-switch
```

## 검증 전용 시장 틱

`POST /api/verification/market-tick`은 `PULSEHFT_ENABLE_VERIFICATION_API=true`이고 로컬 루프백 요청일 때만 존재합니다.

```powershell
$env:PULSEHFT_ENABLE_VERIFICATION_API = "true"
npm start
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-risk-exits.ps1
```

검증 후 환경변수를 제거하고 일반 모드로 재시작합니다.

## 디렉터리

```text
public/                   브라우저 대시보드
server/domain/            분석·내부 모의체결·전략·리스크·실행 저널
server/integrations/kis/  실전 시세 읽기 전용·모의투자 주문 경계
server/test/              단위·런타임 테스트
scripts/                  로컬 설정·결정적 검증 스크립트
docs/                     아키텍처·체결모델·KIS·로드맵
```
