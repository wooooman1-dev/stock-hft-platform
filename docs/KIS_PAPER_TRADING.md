# KIS PAPER_TRADING

PulseHFT의 한국투자증권 모의투자 계좌 연동입니다. 이 모드는 한국투자 모의투자 REST 서버에만 연결되며 실전 주문 서버를 호출하지 않습니다.

## 강제 안전 경계

- 기본값은 `DISABLED`입니다.
- 모의투자 전용 App Key·App Secret·모의계좌가 모두 있어야 시작됩니다.
- 실전 App Key 또는 App Secret과 같은 값이 환경변수에 있으면 시작을 거부합니다.
- 모든 API 경로는 로컬 루프백 요청만 허용합니다.
- 기존 `MarketRuntime`, 내부 `PaperTrader`, 자동전략은 계속 `SIMULATION`입니다.
- 한국투자 모의주문은 자동전략에 연결하지 않았습니다.
- 실전 계좌 주문·정정·취소 코드는 존재하지 않습니다.
- 주문 명령을 실행 저널에 먼저 `fsync`한 뒤 증권사 요청을 보냅니다.
- 네트워크 단절·시간초과·5xx·비정상 응답으로 결과를 확정할 수 없으면 `UNKNOWN_RESULT`로 고정하고 킬 스위치를 켭니다.
- `UNKNOWN_RESULT`는 자동 해제하거나 자동 재주문하지 않습니다.
- 킬 스위치 상태에서도 미체결 주문 취소는 허용합니다.

## 공식 환경

```text
REST base URL: https://openapivts.koreainvestment.com:29443
Token:         POST /oauth2/tokenP
Balance:       GET  /uapi/domestic-stock/v1/trading/inquire-balance
Cash order:    POST /uapi/domestic-stock/v1/trading/order-cash
Revise/cancel: POST /uapi/domestic-stock/v1/trading/order-rvsecncl
Cancelable:    GET  /uapi/domestic-stock/v1/trading/inquire-psbl-rvsecncl
```

사용 TR ID:

```text
잔고              VTTC8434R
현금 매수         VTTC0012U
현금 매도         VTTC0011U
정정·취소         VTTC0013U
정정취소 가능조회 VTTC0084R
```

## 자격정보 설정

실전 키와 모의투자 키는 완전히 분리합니다. 실제 값은 채팅, 로그, Git, API 응답에 넣지 않습니다.

권장 설정:

```powershell
cd F:\Project\stock-hft-platform
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\configure-kis-paper-trading.ps1
```

스크립트는 다음 파일을 로컬에 만들고 현재 Windows 사용자만 접근하도록 ACL을 제한합니다.

```text
.pulsehft/kis-paper.json
.pulsehft/start-kis-paper-trading.ps1
```

실행:

```powershell
& .\.pulsehft\start-kis-paper-trading.ps1
```

환경변수 방식을 사용할 때는 다음 이름만 사용합니다.

```dotenv
PULSEHFT_KIS_PAPER_MODE=PAPER_TRADING
PULSEHFT_KIS_PAPER_APP_KEY="모의투자 전용 APP KEY"
PULSEHFT_KIS_PAPER_APP_SECRET="모의투자 전용 APP SECRET"
PULSEHFT_KIS_PAPER_ACCOUNT_NUMBER="모의계좌 앞 8자리"
PULSEHFT_KIS_PAPER_ACCOUNT_PRODUCT_CODE="01"
```

## 안전 한도

기본값:

```dotenv
PULSEHFT_KIS_PAPER_MAX_ORDER_QUANTITY=10
PULSEHFT_KIS_PAPER_MAX_ORDER_VALUE=1000000
PULSEHFT_KIS_PAPER_MAX_DAILY_ORDERS=20
PULSEHFT_KIS_PAPER_MAX_DAILY_LOSS=100000
```

- 시장가 주문은 `referencePrice`로 주문 추정금액을 계산합니다.
- 일일 손실은 한국시간 날짜별 최초 잔고의 총평가금액을 실행 저널에 기준값으로 저장하고 현재 총평가금액과 비교합니다.
- 현재 평가손익이 더 큰 손실을 나타내면 더 보수적인 값을 적용합니다.
- 기준값과 주문 명령은 재시작 후에도 같은 append-only 저널에서 복원됩니다.

## 로컬 API

```text
GET  /api/kis/paper/status
GET  /api/kis/paper/balance
POST /api/kis/paper/orders
POST /api/kis/paper/orders/revise
POST /api/kis/paper/orders/cancel
POST /api/kis/paper/kill-switch
```

지정가 매수 예시:

```json
{
  "clientOrderId": "manual-20260801-0001",
  "side": "BUY",
  "symbol": "005930",
  "type": "LIMIT",
  "quantity": 1,
  "limitPrice": 70000,
  "referencePrice": 70000,
  "exchange": "KRX"
}
```

시장가 매도 예시:

```json
{
  "clientOrderId": "manual-20260801-0002",
  "side": "SELL",
  "symbol": "005930",
  "type": "MARKET",
  "quantity": 1,
  "referencePrice": 70000,
  "exchange": "KRX"
}
```

정정 예시:

```json
{
  "clientOrderId": "revise-20260801-0001",
  "originalOrderNumber": "원주문번호",
  "orderOrganizationNumber": "주문조직번호",
  "type": "LIMIT",
  "quantity": 1,
  "limitPrice": 70500,
  "referencePrice": 70500,
  "exchange": "KRX",
  "allQuantity": true
}
```

취소 예시:

```json
{
  "clientOrderId": "cancel-20260801-0001",
  "originalOrderNumber": "원주문번호",
  "orderOrganizationNumber": "주문조직번호",
  "quantity": 1,
  "exchange": "KRX",
  "allQuantity": true
}
```

정정·취소 전에 반드시 한국투자 정정취소 가능 주문을 조회하고 가능 수량을 확인합니다. 취소 요청에 주문유형을 생략하면 조회된 원주문의 주문구분과 가격을 사용합니다.

## 실행 저널과 멱등성

추가 이벤트:

```text
BROKER_RISK_BASELINE
BROKER_ORDER_COMMAND
BROKER_ORDER_RESULT
BROKER_ORDER_UNKNOWN
```

`clientOrderId`는 1~80자의 영문·숫자·점·밑줄·콜론·하이픈만 허용합니다. 이미 처리한 `clientOrderId`가 다시 들어오면 증권사 요청을 재전송하지 않고 저장된 결과를 반환합니다.

프로세스가 `BROKER_ORDER_COMMAND` 이후 종료되고 결과 이벤트가 없으면 다음 시작 시 해당 명령을 `UNKNOWN_RESULT`로 기록합니다. 사용자는 한국투자 모의계좌 주문내역과 직접 대조하기 전 킬 스위치를 해제할 수 없습니다.

## 수동 검증 순서

1. 모의투자 전용 키와 모의계좌를 발급합니다.
2. 설정 스크립트를 실행합니다.
3. 서버 시작 후 `/api/kis/paper/status`에서 `environment=PAPER`, `orderApiAvailable=true`를 확인합니다.
4. `/api/kis/paper/balance`로 모의 잔고를 확인합니다.
5. 장중에 1주 지정가 매수 주문을 제출합니다.
6. 동일 `clientOrderId`를 다시 보내 증권사 주문이 중복되지 않는지 확인합니다.
7. 주문번호와 주문조직번호를 사용해 정정·취소를 확인합니다.
8. 서버 재시작 후 같은 `clientOrderId` 결과가 재생되는지 확인합니다.
9. 테스트 중 강제 종료로 `UNKNOWN_RESULT`를 만들었다면 모의계좌 주문내역과 대조하고 새 주문이 차단되는지 확인합니다.
10. `npm run check`를 실행합니다.

실전 App Key로 위 검증을 수행하지 않습니다.
