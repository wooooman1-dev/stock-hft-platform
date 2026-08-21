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
- `UNKNOWN_RESULT`는 자동 해제하거나 자동 재주문하지 않습니다. 사용자가 증권사 주문내역과 대조해 접수 여부를 확정해야만 풀립니다.
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
POST /api/kis/paper/orders/resolve-unknown
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
BROKER_ORDER_UNKNOWN_RESOLVED
```

`clientOrderId`는 1~80자의 영문·숫자·점·밑줄·콜론·하이픈만 허용합니다. 이미 처리한 `clientOrderId`가 다시 들어오면 증권사 요청을 재전송하지 않고 저장된 결과를 반환합니다.

프로세스가 `BROKER_ORDER_COMMAND` 이후 종료되고 결과 이벤트가 없으면 다음 시작 시 해당 명령을 `UNKNOWN_RESULT`로 기록합니다. 사용자는 한국투자 모의계좌 주문내역과 직접 대조하기 전 킬 스위치를 해제할 수 없습니다.

## 주문 결과 불명 해소 절차

`UNKNOWN_RESULT`는 증권사 주문내역과 대조한 사용자의 확정 없이는 풀리지 않습니다. 확정 결과는 `BROKER_ORDER_UNKNOWN_RESOLVED` 이벤트로 실행 저널에 남고, 재시작 후에도 같은 결론이 재생됩니다.

1. `/api/kis/paper/status`의 `service.unknownCommands`에서 해소해야 할 `clientOrderId`와 원래 주문 요청을 확인합니다.
2. 대조 대상을 정리합니다.

```powershell
npm run resolve:kis:paper-unknown
```

   인자 없이 실행하면 결과 불명 명령과 같은 조건의 KIS 당일 주문내역 후보만 읽어서 보여주고 아무것도 바꾸지 않습니다.

3. 한국투자 모의계좌 주문내역에서 해당 주문의 접수 여부를 직접 확인합니다.
4. 접수된 것으로 확인되면 주문번호를 함께 확정합니다.

```powershell
$env:PULSEHFT_RESOLVE_KIS_PAPER_UNKNOWN="YES"
npm run resolve:kis:paper-unknown -- --client-order-id=... --resolution=ACCEPTED --broker-order-number=... --order-organization-number=... --note="주문내역 대조 완료"
```

5. 접수되지 않은 것으로 확인되면 `--resolution=NOT_ACCEPTED`로 확정합니다.

서버는 사용자의 확정을 그대로 믿지 않고 KIS 당일 주문내역으로 교차검증합니다.

- `ACCEPTED`는 지정한 주문번호가 당일 주문내역에 있어야 하고, 종목코드·매매구분·주문수량이 실행 저널 명령과 같아야 합니다.
- 이미 다른 실행 저널 명령의 결과로 기록된 주문번호는 다시 연결할 수 없습니다.
- `NOT_ACCEPTED`는 같은 조건의 미추적 주문이 당일 주문내역에 남아 있으면 거부합니다.
- 대조 근거를 읽지 못하면 확정하지 않고 그대로 차단을 유지합니다.

확정 이후 동작:

- `ACCEPTED`로 확정한 명령은 같은 `clientOrderId`로 재요청해도 증권사 재주문 없이 확정된 주문번호를 반환합니다.
- `NOT_ACCEPTED`로 확정한 명령은 같은 `clientOrderId`로 재요청하면 거절 결과를 재생합니다. 다시 주문하려면 새 `clientOrderId`를 사용합니다.
- 결과 불명 명령이 모두 해소되면 킬 스위치를 해제할 수 있습니다. 해제 시점에 계좌 대조가 정상이어야 하며 확인 기록이 실행 저널에 남습니다.

## 수동 검증 순서

1. 모의투자 전용 키와 모의계좌를 발급합니다.
2. 설정 스크립트를 실행합니다.
3. 서버 시작 후 `/api/kis/paper/status`에서 `environment=PAPER`, `orderApiAvailable=true`를 확인합니다.
4. `/api/kis/paper/balance`로 모의 잔고를 확인합니다.
5. 장중에 1주 지정가 매수 주문을 제출합니다.
6. 동일 `clientOrderId`를 다시 보내 증권사 주문이 중복되지 않는지 확인합니다.
7. 주문번호와 주문조직번호를 사용해 정정·취소를 확인합니다.
8. 서버 재시작 후 같은 `clientOrderId` 결과가 재생되는지 확인합니다.
9. 테스트 중 강제 종료로 `UNKNOWN_RESULT`를 만들었다면 모의계좌 주문내역과 대조하고 새 주문이 차단되는지 확인합니다. 대조를 마친 뒤 `npm run resolve:kis:paper-unknown`으로 접수·미접수를 확정하고 킬 스위치를 해제합니다.
10. `npm run check`를 실행합니다.

실전 App Key로 위 검증을 수행하지 않습니다.

## 검증 이력

### 2026-08-21 — 모의투자 전용 키·계좌 실계정 검증

장중(KST 10:29~11:18)에 모의투자 전용 키와 모의계좌로 위 수동 검증 순서 6~10번을 모두 실행했습니다.

- **6. 멱등성**: 동일 `clientOrderId` 재전송 시 `replayed:true`, 주문번호 동일, 저널에 COMMAND/RESULT 1쌍만 기록되고 증권사 재요청이 발생하지 않음을 확인.
- **7. 정정·취소**: 지정가 매수 1주 → 정정 → 취소까지 확인. 취소 전 정정취소 가능수량 선조회가 정상 통과했고, 취소 후 미체결 0건·현금과 포지션이 원복됨을 확인.
- **8. 재시작 재생**: 서버 재시작 후 동일 `clientOrderId` 재전송 시 `replayed:true`로 저널에서 복원되고 증권사 재요청이 없음을 확인.
- **9. 강제 종료 → `UNKNOWN_RESULT`**: `BROKER_ORDER_COMMAND` 기록 직후 프로세스를 강제 종료해 재시작 시 `BROKER_ORDER_UNKNOWN`이 기록되고 킬 스위치가 래치됨을 확인. 신규 주문은 423으로 차단되고 킬 스위치 해제는 409로 거부되는 반면 미체결 취소는 허용됨을 확인. 계좌 대조가 `BROKER_ORDER_NOT_IN_JOURNAL`로 실제 증권사 미체결 주문을 정확히 탐지해 취소 완료.
  - 이 과정에서 `UNKNOWN_RESULT`를 해소할 절차가 코드에 없다는 공백을 발견해 **주문 결과 불명 해소 절차**(`BROKER_ORDER_UNKNOWN_RESOLVED` 이벤트, `/api/kis/paper/orders/resolve-unknown`, `npm run resolve:kis:paper-unknown`)를 구현했습니다. 구현한 절차로 실제 발생한 `UNKNOWN_RESULT`를 해소해 검증했습니다: 목록 모드가 결과 불명 명령과 일치하는 증권사 주문번호 1건만 정확히 후보로 좁혔고, `ACCEPTED`로 확정한 뒤 킬 스위치를 해제하자 계좌 대조가 `CONSISTENT`로 돌아왔습니다. 이후 신규 주문 제출·취소가 정상 동작했고, 서버 재시작 후에도 해소 상태가 재생되어 킬 스위치가 다시 래치되지 않음을 확인했습니다.
- **10. `npm run check`**: 212 tests / 0 fail.

검증 종료 시점 계좌 상태: 미체결 0건, 포지션 0, 현금 9,998,390원(변동 없음).
