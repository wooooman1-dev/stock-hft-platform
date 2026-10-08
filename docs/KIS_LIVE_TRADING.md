# KIS LIVE_TRADING (실전투자 카나리)

PulseHFT의 한국투자증권 **실전 계좌** 연동입니다. 실제 돈이 오가는 주문을 제출할 수 있는 유일한 경로이며, `docs/ROADMAP.md` Phase 5의 "사용자 별도 승인 전 실전 주문 구현 금지"에 따라 사용자의 명시적 승인 이후에만 구현되었습니다. `docs/KIS_PAPER_TRADING.md`(모의투자)와 구조가 거의 동일하지만, 실제 자본이 걸려 있으므로 **1주 카나리** 단계로 범위를 좁혔습니다.

## 강제 안전 경계

- 기본값은 `DISABLED`입니다.
- 실전투자 전용 App Key·App Secret·실계좌가 모두 있어야 시작됩니다(모의투자·실전 시세 읽기 전용 자격정보와 양방향으로 재사용 금지).
- **이중 게이트**: `PULSEHFT_KIS_LIVE_MODE=LIVE_TRADING`만으로는 주문을 낼 수 없습니다. `PULSEHFT_KIS_LIVE_ORDER_ENABLED=true`까지 별도로 켜야만 `KisLiveOrderService`가 생성되고 주문 API가 응답합니다. 잔고 조회만 켜고 싶을 때 실수로 주문까지 가능해지는 사고를 막기 위한 것입니다.
- **수동 주문의 1주 하드 상한**: 수동 주문(`POST /api/kis/live/orders`)은 주문 처리 시점에 `quantity !== 1`이면 즉시 거부됩니다. 이 검사는 HTTP 본문으로 우회할 수 없습니다(자동매매 어댑터만 서버 코드에서 `automated` 옵션을 넘깁니다). 설정 로드 시점의 `maxOrderQuantity` 상한은 2026-10-08 실전 자동매매 도입과 함께 1에서 10,000으로 완화했습니다.
- 모의투자·실전 시세 읽기 전용과 완전히 분리된 실행 저널(`execution-journal-live.jsonl`)과 토큰 파일(`kis-live-token.json`)을 사용합니다. 같은 `clientOrderId`가 다른 계좌의 주문과 섞이지 않습니다.
- 기존 `MarketRuntime`, 내부 `PaperTrader`, 자동전략은 계속 `SIMULATION`이며 실전 계좌와 무관합니다.
- 내부 시뮬레이터의 자동전략과 반자동 승인 모드(`approvalMode: SEMI_AUTO`)는 SIMULATION 전용이며 실전 주문과 무관합니다. 실전 자동매매는 아래 "실전 자동매매" 절의 별도 경로입니다(세 번째 게이트가 꺼져 있으면 연결되지 않습니다).
- 수동 실전 주문 화면은 `public/kisLiveOrderPanel.js`, 실전 자동매매 화면은 자동매매 패널(`public/autoTradingPanel.js`)의 "실전투자" 탭입니다.
- 진단 전용 기능인 내부 체결모델 비교(`fill-comparison`)는 이번 카나리 범위에서 제외했습니다.
- 주문 명령을 실행 저널에 먼저 `fsync`한 뒤 증권사 요청을 보냅니다.
- 네트워크 단절·시간초과·5xx·비정상 응답으로 결과를 확정할 수 없으면 `UNKNOWN_RESULT`로 고정하고 킬 스위치를 켭니다.
- `UNKNOWN_RESULT`는 자동 해제하거나 자동 재주문하지 않습니다. 사용자가 실계좌 주문내역과 대조해 접수 여부를 확정해야만 풀립니다.
- 킬 스위치 상태에서도 미체결 주문 취소는 허용합니다.

## 공식 환경

```text
REST base URL: https://openapi.koreainvestment.com:9443
Token:         POST /oauth2/tokenP
Balance:       GET  /uapi/domestic-stock/v1/trading/inquire-balance
Cash order:    POST /uapi/domestic-stock/v1/trading/order-cash
Revise/cancel: POST /uapi/domestic-stock/v1/trading/order-rvsecncl
```

사용 TR ID(한국투자증권 공식 GitHub `koreainvestment/open-trading-api`의 `examples_llm/domestic_stock/*` 샘플에서 `env_dv === "real"` 분기 값을 직접 확인함, 모의투자 `VTTC*`를 추정으로 바꾼 것이 아님):

```text
잔고              TTTC8434R
현금 매수         TTTC0012U
현금 매도         TTTC0011U
정정·취소         TTTC0013U
당일 주문·체결조회 TTTC0081R (3개월 이내 조회 전용 — 이 클라이언트는 항상 당일만 조회하므로 3개월 이전 조회용 CTSC9215R은 구현하지 않음)
```

## 자격정보 설정

실전 시세 읽기 전용 키, 모의투자 키, 실전투자(주문) 키를 서로 재사용하지 않습니다. 실제 값은 채팅, 로그, Git, API 응답에 넣지 않습니다.

```dotenv
PULSEHFT_KIS_LIVE_MODE=LIVE_TRADING
PULSEHFT_KIS_LIVE_APP_KEY="실전투자 전용 APP KEY"
PULSEHFT_KIS_LIVE_APP_SECRET="실전투자 전용 APP SECRET"
PULSEHFT_KIS_LIVE_ACCOUNT_NUMBER="실계좌 앞 8자리"
PULSEHFT_KIS_LIVE_ACCOUNT_PRODUCT_CODE="01"
PULSEHFT_KIS_LIVE_ORDER_ENABLED=true
```

`PULSEHFT_KIS_LIVE_ORDER_ENABLED`를 생략하거나 `true` 외의 값으로 두면 잔고 조회는 되지만 주문 API는 항상 503을 반환합니다.

## 안전 한도

기본값(카나리 단계 승인 시 사용자가 직접 정한 값 — 실제 계좌 자본 규모에 맞게 재조정해야 합니다):

```dotenv
PULSEHFT_KIS_LIVE_MAX_ORDER_QUANTITY=1        # 설정 상한은 10,000. 수동 주문은 이 값과 무관하게 정확히 1주
PULSEHFT_KIS_LIVE_MAX_ORDER_VALUE=2000000
PULSEHFT_KIS_LIVE_MAX_DAILY_ORDERS=5
PULSEHFT_KIS_LIVE_MAX_DAILY_LOSS=20000
PULSEHFT_KIS_LIVE_MAX_CONSECUTIVE_LOSSES=2
```

- 모의투자와 마찬가지로 시장가 주문은 `referencePrice`로 주문 추정금액을 계산하고, 일일 손실은 한국시간 날짜별 최초 총평가금액을 기준값으로 저장해 비교합니다.
- 연속 손실 한도는 실행 저널의 체결 이벤트로 FIFO 매칭한 실현손익 기준 연속 손실 거래 횟수가 한도에 도달하면 킬 스위치를 켭니다.
- 장 종료 이후 보유 포지션은 `/api/kis/live/status`의 `service.marketSession.afterHoursPositionsOpen`으로만 알림이 뜨며 자동 청산은 없습니다.

## 실전 자동매매 (2026-10-08)

모의투자 자동매매(`docs/AUTO_TRADING_PAPER_DESIGN.md`)와 **같은 매매 로직**(`KisPaperAutoTrader`)을 실전 주문 서비스에 다른 인스턴스로 붙인 것입니다. 진입·청산 조건, 설정 항목, 화면이 모의와 같고, 다른 점은 아래뿐입니다.

- **세 번째 게이트**: `PULSEHFT_KIS_LIVE_AUTO_TRADING_ENABLED=true`(그리고 `LIVE_MODE`, `ORDER_ENABLED`)가 모두 있어야 연결됩니다. 기본은 꺼짐입니다.
- **항상 꺼진 채 시작**: 서버가 시작될 때 실전 자동매매는 저장 파일에 `enabled:true`가 있어도 꺼진 상태입니다. 화면 "실전투자" 탭에서 매번 직접 켜며, 켤 때 확인창과 서버 쪽 확인(`confirmLive`)을 거칩니다.
- **정규장 KRX만**: 자동 주문은 `exchange: "KRX"`로 내고, 평가는 평일 09:00~15:30에만 돕니다. SOR/NXT 라우팅은 실전에서 검증하지 않았습니다.
- **분리된 상태 파일**: 설정 `.pulsehft/live-auto-trading-config.json`, 보유 상태 `.pulsehft/live-auto-trading-state.json`, 실행 저널은 기존 `execution-journal-live.jsonl`. 동시 보유 기본값은 3종목입니다.
- **기존 보유 종목은 건드리지 않음**: 자동매매를 처음 켜는 시점에 계좌에 이미 있던 종목(사람이 직접 산 보유분)은 손절·시간 청산·강제 청산 대상이 아니고, 그 종목에 자동 진입도 하지 않습니다. 실행 저널에서 이 자동매매가 최근 3일 안에 산 종목(`AUTO:BUY:` 주문)이나 저장된 포지션은 자기 것으로 봅니다. 화면에 "건드리지 않는 기존 보유" 목록이 표시됩니다.
- **한도는 .env로만**: 화면에서는 읽기 전용입니다. 자동매매 플래그를 켜면 기본 한도가 "소액 시험"으로 바뀝니다(아래 표). `PULSEHFT_KIS_LIVE_MAX_*`로 덮어쓸 수 있습니다.

| 한도 | 수동만(플래그 꺼짐) | 자동매매 켬(소액 시험) |
|---|---|---|
| 1회 최대 수량 | 1 | 1,000 (금액 한도가 먼저 걸림) |
| 1회 최대 금액 | 2,000,000원 | 200,000원 |
| 일일 주문 수 | 5 | 30 |
| 일일 손실 한도 | 20,000원 | 50,000원 |
| 연속 손실 한도 | 2회 | 3회 |

### 킬 스위치와 보호 매도

- 일 손실·연속 손실 **한도로 켜진** 킬 스위치(`killSwitchReason: "LIMIT"`)에서는 신규 진입은 막히지만, 이미 보유한 종목의 보호 매도(손절·익절·시간 청산·강제 청산)는 통과합니다. 보호 매도는 수량·금액·일 한도 검사도 받지 않습니다.
- **주문 결과 불명(`UNKNOWN_RESULT`)·계좌 대사 불일치·수동 킬 스위치**에서는 보호 매도도 차단됩니다. 상태를 믿을 수 없을 때는 사람이 증권사 앱에서 직접 확인·정리해야 합니다.
- 이 규칙은 자동매매 어댑터(`automated`)에서 `protectiveExit`가 붙은 **매도**에만 적용됩니다. 수동 주문과 매수에는 적용되지 않습니다.
- 모의투자 주문 서비스(`KisPaperOrderService`)도 2026-10-08부터 같은 규칙입니다(`killSwitchReason`, 보호 매도의 한도 검사 면제). 모의 자동매매의 기본 한도와 동시 보유 종목 수도 같은 "소액 시험" 값(종목당 20만원, 3종목, 일 주문 30건, 일 손실 5만원, 연속 손실 3회)으로 맞췄습니다.

### 알려진 한계

- 모의 검증은 짧은 기간이고 모의 체결은 시뮬레이션이라, 실전 슬리피지·체결은 다를 수 있습니다.
- 성과 화면의 비용은 모의와 같은 설정값 기반 추정치(수수료·세금)입니다. 실제 정산내역과 대조해야 합니다.
- 실전에는 성과 집계 시작 시각(`performance/reset`) 개념이 없습니다.

## 로컬 API

```text
GET  /api/kis/live/status
GET  /api/kis/live/balance
GET  /api/kis/live/performance
POST /api/kis/live/orders
POST /api/kis/live/orders/revise
POST /api/kis/live/orders/cancel
GET  /api/kis/live/auto-trading              # 자동매매 상태·설정 (세 번째 게이트가 꺼져 있으면 503)
POST /api/kis/live/auto-trading              # 설정 변경·시작·정지 (꺼진 상태에서 켜려면 본문에 confirmLive:true)
POST /api/kis/live/auto-trading/resume       # 자동매매 멈춤 해제
GET  /api/kis/live/limits                    # 안전 한도 (읽기 전용)
POST /api/kis/live/orders/resolve-unknown
POST /api/kis/live/kill-switch
```

모든 경로는 로컬 루프백 요청만 허용하며(`rejectNonLoopbackKisRequest`), `KisMainWorkspace`(모의투자 전용 오케스트레이터)를 거치지 않고 `KisLiveOrderService`를 직접 호출합니다 — 종목 자동 선택이나 스냅샷 브로드캐스트가 없으므로 요청 본문에 `symbol`·`referencePrice`(시장가) 또는 `limitPrice`(지정가)를 직접 지정해야 합니다.

지정가 매수 예시(1주 고정):

```json
{
  "clientOrderId": "live-canary-20260901-0001",
  "side": "BUY",
  "symbol": "005930",
  "type": "LIMIT",
  "quantity": 1,
  "limitPrice": 70000,
  "referencePrice": 70000,
  "exchange": "KRX"
}
```

`quantity`가 1이 아니면 `KIS_LIVE_CANARY_QUANTITY_LIMIT`으로 즉시 거부됩니다. 정정·취소·주문 결과 불명 해소 요청 형식은 모의투자와 동일합니다(`docs/KIS_PAPER_TRADING.md`의 예시 참고, `clientOrderId` 규칙도 동일하게 1~80자 영문·숫자·점·밑줄·콜론·하이픈).

## 실행 저널과 멱등성

모의투자와 동일한 이벤트 이름을 쓰지만 **물리적으로 별도 파일**(`execution-journal-live.jsonl`)에 기록되므로 서로의 `clientOrderId` 명령이 섞이지 않습니다.

```text
BROKER_RISK_BASELINE
BROKER_ORDER_COMMAND
BROKER_ORDER_RESULT
BROKER_ORDER_UNKNOWN
BROKER_ORDER_UNKNOWN_RESOLVED
BROKER_RECONCILIATION_BASELINE
BROKER_RECONCILIATION_MISMATCH
BROKER_RECONCILIATION_ACKNOWLEDGED
BROKER_EQUITY_SNAPSHOT
BROKER_FILL_OBSERVED
```

`UNKNOWN_RESULT` 해소 절차는 모의투자와 완전히 동일합니다 — `resolution: "ACCEPTED"|"NOT_ACCEPTED"`를 `POST /api/kis/live/orders/resolve-unknown`으로 보내면, 서버는 사용자의 주장을 그대로 믿지 않고 KIS 당일 주문내역으로 교차검증합니다. 카나리 단계에는 모의투자의 `npm run resolve:kis:paper-unknown` 같은 별도 CLI 스크립트를 만들지 않았으므로, API를 직접 호출해야 합니다.

## 수동 검증 순서

**실전 App Key로 아래 절차를 수행하는 것은 실제 자본을 거는 행위입니다. 최소 단위(1주)로만 진행하고, 각 단계마다 실계좌 주문내역을 직접 대조하세요.**

1. 실전투자 전용 키와 실계좌를 준비합니다(모의투자·시세 전용 키와 절대 겹치지 않아야 함).
2. `PULSEHFT_KIS_LIVE_MODE=LIVE_TRADING`만 켜고 서버를 시작해 `/api/kis/live/status`에서 `environment=LIVE`, `balanceApiAvailable=true`, `orderApiAvailable=false`를 확인합니다.
3. `/api/kis/live/balance`로 실계좌 잔고를 확인합니다.
4. `PULSEHFT_KIS_LIVE_ORDER_ENABLED=true`를 켜고 재시작해 `orderApiAvailable=true`가 되는지 확인합니다.
5. 장중에 1주 지정가 매수 주문을 제출하고, 실제 HTS·MTS에서도 같은 주문이 보이는지 대조합니다.
6. 동일 `clientOrderId`를 다시 보내 증권사 주문이 중복되지 않는지 확인합니다.
7. 주문번호와 주문조직번호를 사용해 정정·취소를 확인합니다.
8. 서버 재시작 후 같은 `clientOrderId` 결과가 재생되는지 확인합니다.
9. `npm run check`를 실행합니다(자동 테스트는 가짜 클라이언트만 사용하며 실제 KIS 실전 엔드포인트에 요청하지 않습니다).

## 검증 이력

_아직 실계좌 수동 검증이 수행되지 않았습니다. 위 절차를 실제로 완료한 뒤, `docs/KIS_PAPER_TRADING.md`의 검증 이력과 같은 형식(날짜, 수행한 단계, 확인한 결과, 발견한 문제와 조치)으로 이 섹션을 채우세요._

## 시세용 자격정보 공유 (2026-09-07)

원래 설계는 실전 시세 조회용 App Key와 실전 주문용 App Key를 서로 다른 계좌에서 발급받아 분리하는 것이다. `kisLiveConfig.js`의 `rejectPaperAndProdCredentialReuse()`가 부팅 시점에 이를 강제한다.

KIS는 App Key를 계좌 단위로 발급하고 실전투자계좌는 최대 89개까지 API 신청이 가능하므로, 계좌를 추가 등록하면 분리를 유지할 수 있다. 같은 계좌의 신청을 갱신하면 기존 App Key가 무효화된다.

실전 계좌를 하나만 운용해 분리가 불가능한 경우에 한해 `PULSEHFT_KIS_LIVE_ALLOW_SHARED_QUOTE_CREDENTIAL=true`로 명시적으로 옵트인할 수 있다. 기본값은 `false`이며, 플래그가 없으면 종전과 동일하게 `KIS_LIVE_QUOTE_CREDENTIAL_REUSE`로 기동을 거부한다.

옵트인 시 다음이 남는다.

- `kisLiveConfiguration.sharedQuoteCredential = true`
- `publicKisLiveConfiguration()`의 `sharedQuoteCredential` 필드로 상태 API 노출
- 기동 시 `[KIS-LIVE]` 경고 로그
- 실전 저널(`execution-journal-live.jsonl`)에 `LIVE_SHARED_QUOTE_CREDENTIAL_ENABLED` 이벤트

### 수용한 위험

시세 조회 경로의 결함이 주문 제출 권한을 가진 자격정보에 도달할 수 있다. KIS 실전 App Key는 원래 시세와 주문 권한을 모두 가지므로 이 경계는 증권사 차원의 권한 분리가 아니라 저장소 내부의 격리 장치였고, 옵트인은 그 내부 격리를 포기하는 것이다.

1주 하드 상한과 `PULSEHFT_KIS_LIVE_MODE`/`PULSEHFT_KIS_LIVE_ORDER_ENABLED` 이중 플래그는 영향을 받지 않는다.

### 옵트인 대상이 아닌 것

모의투자 자격정보 재사용(`KIS_LIVE_PAPER_CREDENTIAL_REUSE`)은 이 플래그와 무관하게 항상 거부한다. 모의투자는 도메인(`openapivts…:29443`)이 달라 실전 주문에 쓸 수 없으므로 언제나 설정 오류다.
