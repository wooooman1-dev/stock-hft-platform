# KIS LIVE_TRADING (실전투자 카나리)

PulseHFT의 한국투자증권 **실전 계좌** 연동입니다. 실제 돈이 오가는 주문을 제출할 수 있는 유일한 경로이며, `docs/ROADMAP.md` Phase 5의 "사용자 별도 승인 전 실전 주문 구현 금지"에 따라 사용자의 명시적 승인 이후에만 구현되었습니다. `docs/KIS_PAPER_TRADING.md`(모의투자)와 구조가 거의 동일하지만, 실제 자본이 걸려 있으므로 **1주 카나리** 단계로 범위를 좁혔습니다.

## 강제 안전 경계

- 기본값은 `DISABLED`입니다.
- 실전투자 전용 App Key·App Secret·실계좌가 모두 있어야 시작됩니다(모의투자·실전 시세 읽기 전용 자격정보와 양방향으로 재사용 금지).
- **이중 게이트**: `PULSEHFT_KIS_LIVE_MODE=LIVE_TRADING`만으로는 주문을 낼 수 없습니다. `PULSEHFT_KIS_LIVE_ORDER_ENABLED=true`까지 별도로 켜야만 `KisLiveOrderService`가 생성되고 주문 API가 응답합니다. 잔고 조회만 켜고 싶을 때 실수로 주문까지 가능해지는 사고를 막기 위한 것입니다.
- **1주 하드 상한**: 설정 로드 시점(`maxOrderQuantity`의 상한 자체가 1)과 주문 처리 시점(`quantity !== 1`이면 즉시 거부) 두 곳에서 각각 독립적으로 강제됩니다. 둘 중 하나가 나중에 실수로 완화되어도 다른 하나가 카나리 규모를 계속 1주로 제한합니다.
- 모의투자·실전 시세 읽기 전용과 완전히 분리된 실행 저널(`execution-journal-live.jsonl`)과 토큰 파일(`kis-live-token.json`)을 사용합니다. 같은 `clientOrderId`가 다른 계좌의 주문과 섞이지 않습니다.
- 기존 `MarketRuntime`, 내부 `PaperTrader`, 자동전략은 계속 `SIMULATION`이며 실전 계좌와 무관합니다.
- 실전 주문은 자동전략에 연결하지 않았습니다. 반자동 승인 모드(`approvalMode: SEMI_AUTO`)도 SIMULATION 전용이며 실전 주문과는 무관합니다.
- **UI가 없습니다.** API·테스트로만 완결되어 있으며, 대시보드(`public/`)에 실전 주문 화면을 추가하지 않았습니다.
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
PULSEHFT_KIS_LIVE_MAX_ORDER_QUANTITY=1        # 이 값의 상한 자체가 1로 고정되어 있어 그 이상 설정 시 기동 실패
PULSEHFT_KIS_LIVE_MAX_ORDER_VALUE=2000000
PULSEHFT_KIS_LIVE_MAX_DAILY_ORDERS=5
PULSEHFT_KIS_LIVE_MAX_DAILY_LOSS=20000
PULSEHFT_KIS_LIVE_MAX_CONSECUTIVE_LOSSES=2
```

- 모의투자와 마찬가지로 시장가 주문은 `referencePrice`로 주문 추정금액을 계산하고, 일일 손실은 한국시간 날짜별 최초 총평가금액을 기준값으로 저장해 비교합니다.
- 연속 손실 한도는 실행 저널의 체결 이벤트로 FIFO 매칭한 실현손익 기준 연속 손실 거래 횟수가 한도에 도달하면 킬 스위치를 켭니다.
- 장 종료 이후 보유 포지션은 `/api/kis/live/status`의 `service.marketSession.afterHoursPositionsOpen`으로만 알림이 뜨며 자동 청산은 없습니다.

## 로컬 API

```text
GET  /api/kis/live/status
GET  /api/kis/live/balance
GET  /api/kis/live/performance
POST /api/kis/live/orders
POST /api/kis/live/orders/revise
POST /api/kis/live/orders/cancel
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
