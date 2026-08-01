# PulseHFT Architecture

```text
MarketSimulator (SIMULATION)
  -> Atomic market snapshot
  -> Microstructure analysis
  -> StrategySettings / PositionRiskTracker
  -> Manual / strategy internal paper request
  -> PaperTrader
       ├─ clientOrderId idempotency
       ├─ MARKET IOC / LIMIT GTC
       ├─ partial fills / cancellation
       └─ position / cash accounting
  -> ExecutionJournalRecorder
  -> Node HTTP REST + SSE dashboard

KisProdReadOnlyClient (optional, PROD_READ_ONLY)
  -> production App Key / App Secret only
  -> production OAuth token cache
  -> current-price REST query
  -X-> account / balance / order
  -X-> MarketRuntime / automatic strategy

KisPaperTradingClient (optional, PAPER_TRADING)
  -> separate paper App Key / App Secret / paper account
  -> VTS OAuth token cache
  -> balance / cancelable-order inquiry
  -> buy / sell / revise / cancel
  -> KisPaperOrderService
       ├─ append command before broker mutation
       ├─ durable clientOrderId idempotency
       ├─ quantity / value / daily-count / daily-loss limits
       ├─ UNKNOWN_RESULT on ambiguous outcome
       └─ kill switch; cancel remains available
  -X-> MarketRuntime market input
  -X-> automatic strategy
  -X-> production order URL or production order TR ID
```

브라우저는 표시와 제어만 담당합니다. 비밀정보, 주문 안전 한도, 실행 저널, 멱등성, 킬 스위치는 서버가 소유합니다.

## 분리된 한국투자 경계

### 실전 현재가

- 모드: `PROD_READ_ONLY`
- 주소: `https://openapi.koreainvestment.com:9443`
- 허용: 토큰, 현재가 조회
- 금지: 계좌번호, 잔고, 주문, 정정, 취소

### 모의투자 계좌

- 모드: `PAPER_TRADING`
- 주소: `https://openapivts.koreainvestment.com:29443`
- 자격정보: 모의투자 전용 키·시크릿·계좌
- 허용: 잔고, 현금 매수·매도, 정정·취소
- 금지: 실전 주문 주소·TR ID, 자동전략 연결

모의투자 설정은 실전 환경변수와 다른 이름을 사용합니다. 동일한 실전 키 또는 시크릿을 모의투자 환경변수로 재사용하면 시작을 거부합니다.

## 한국투자 모의주문 상태 흐름

```text
API request
  -> local validation and risk checks
  -> BROKER_RISK_BASELINE (first mutation of KST day)
  -> BROKER_ORDER_COMMAND + fsync
  -> KIS VTS mutation
       ├─ accepted/rejected and durable result
       │    -> BROKER_ORDER_RESULT
       └─ timeout/network/5xx/invalid response/result-journal failure
            -> BROKER_ORDER_UNKNOWN
            -> kill switch ON
            -> no automatic retry
```

동일 `clientOrderId`가 다시 들어오면 실행 저널에서 복원된 결과를 반환하고 증권사 요청을 재전송하지 않습니다. 재시작 시 명령 이벤트만 있고 결과 이벤트가 없으면 결과를 추정하지 않고 `UNKNOWN_RESULT`로 확정합니다.

## 일일 손실 기준

한국시간 날짜별 첫 신규·정정 주문 전에 모의계좌 총평가금액을 `BROKER_RISK_BASELINE`으로 저장합니다. 현재 총평가금액 하락분과 현재 평가손실 중 더 큰 값을 손실로 사용합니다. 기준값은 실행 저널에서 복원되므로 서버 재시작으로 초기화되지 않습니다.

## 정정·취소 안전 절차

정정·취소 전 `inquire-psbl-rvsecncl`을 호출하여 원주문과 가능수량을 확인합니다. 정정·취소 수량이 가능수량을 초과하면 증권사 mutation을 보내지 않습니다. 취소는 킬 스위치 중에도 허용하여 열린 위험을 줄일 수 있게 합니다.

## 실행 저널

허용 이벤트:

```text
SESSION_STARTED
ORDER_CREATED
ORDER_EVENT
FILL
ACCOUNT_RESET
BROKER_RISK_BASELINE
BROKER_ORDER_COMMAND
BROKER_ORDER_RESULT
BROKER_ORDER_UNKNOWN
```

- 한 행 한 이벤트 JSONL
- 연속 sequence
- 시작 시 전체 검증
- append 후 fsync
- 손상 파일 자동 대체 금지
- 비밀값과 계좌번호 원문 기록 금지

## 불변 조건

1. 내부 모의체결과 한국투자 모의계좌 주문은 별도 상태 경계입니다.
2. 실전 시세 자격정보와 모의투자 주문 자격정보를 분리합니다.
3. 실전 주문 URL과 실전 주문 TR ID는 구현하지 않습니다.
4. 증권사 mutation 전에 주문 명령을 영구 기록합니다.
5. 동일 `clientOrderId`는 증권사에 한 번만 전송합니다.
6. 주문 결과를 확정할 수 없으면 신규·정정 주문을 차단합니다.
7. `UNKNOWN_RESULT`는 자동 해제하거나 자동 재시도하지 않습니다.
8. 킬 스위치는 신규·정정 주문보다 우선하지만 취소는 허용합니다.
9. 한국투자 모의주문은 자동전략에 연결하지 않습니다.
10. 키·시크릿·토큰·계좌번호 원문은 API 응답·오류·실행 저널에 노출하지 않습니다.
11. 실행 저널 sequence는 끊김 없이 증가합니다.
12. 일일 위험 기준은 한국시간 날짜별로 저장되고 재시작 후 복원됩니다.

## 로컬 저장

```text
.pulsehft/strategy-settings.json
.pulsehft/execution-journal.jsonl
.pulsehft/kis-prod-read-only.json
.pulsehft/kis-prod-token.json
.pulsehft/kis-paper.json
.pulsehft/kis-paper-token.json
```

`.env`, `.env.local`, `.pulsehft/`는 Git 제외 대상입니다.
