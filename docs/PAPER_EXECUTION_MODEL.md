# Internal Paper Execution Model

이 문서는 현재 PulseHFT 내부 모의주문의 **구현된 규칙과 구현되지 않은 범위**를 구분합니다.

## 주문 상태

```text
PENDING_SUBMIT
  ├─ REJECTED
  └─ ACCEPTED
       ├─ FILLED
       ├─ PARTIALLY_FILLED (지정가 잔량 대기)
       ├─ PARTIALLY_FILLED (시장가 IOC 잔량 취소, 종료)
       └─ CANCELLED
```

각 주문은 다음 수량을 별도로 보관합니다.

- `requestedQuantity`
- `filledQuantity`
- `remainingQuantity`
- `cancelledQuantity`
- `rejectedQuantity`

모든 상태에서 `filled + remaining + cancelled + rejected = requested` 수량 불변조건을 검사합니다.

`PARTIALLY_FILLED` 상태는 `isOpen`으로 구분합니다.

- `isOpen: true`: 지정가 미체결 잔량이 대기 중
- `isOpen: false`: 시장가 IOC의 미체결 잔량이 취소되어 종료됨

## 시장가 주문

시장가 주문의 Time in Force는 `IOC`로 고정됩니다.

1. 매수는 최우선 매도호가부터 순서대로 체결합니다.
2. 매도는 최우선 매수호가부터 순서대로 체결합니다.
3. 여러 호가에 걸쳐 체결되면 수량 가중평균 체결가를 계산합니다.
4. 화면에 표시된 호가 잔량이 부족하면 보이지 않는 유동성을 만들어내지 않습니다.
5. 보이는 잔량만 부분 체결한 뒤 나머지는 취소합니다.

## 지정가 주문

지정가 주문의 Time in Force는 `GTC`로 고정됩니다.

- 지정가 매수: 매도호가가 지정가 이하일 때만 체결
- 지정가 매도: 매수호가가 지정가 이상일 때만 체결
- 즉시 체결되지 않은 잔량은 열린 주문으로 유지
- 사용자가 열린 주문을 취소할 수 있음
- 다음 시장 스냅샷에서 가격이 교차하면 열린 주문을 FIFO 순서로 재평가

현재는 실제 거래소 큐 위치를 알 수 없으므로, **가격이 교차한 표시호가의 수량 범위 안에서만** 체결합니다.

## 중복 주문 방지

각 주문은 `clientOrderId`를 가집니다.

- 동일한 ID와 동일한 주문 내용 재전송: 기존 주문을 그대로 반환
- 동일한 ID와 다른 주문 내용 재전송: HTTP 409 충돌

이를 통해 네트워크 재시도 과정에서 같은 주문이 두 번 실행되는 것을 막습니다.

## 예약 자원

열린 주문은 이후 주문의 리스크 검사에 반영됩니다.

- 열린 지정가 매수: `limitPrice × remainingQuantity` 현금 예약
- 열린 지정가 매도: `remainingQuantity` 보유수량 예약
- 예약금액은 `availableCash`에서 제외
- 예약수량은 `sellableQuantity`에서 제외

## 현재 적용되는 리스크 제한

- 1회 최대 주문수량
- 최대 예상 보유수량
- 최대 예상 포지션 금액
- 가용현금
- 매도 가능 수량
- 누적 실현손실 제한
- 킬 스위치

## 수수료·세금·슬리피지 모델

`PaperTrader` 자체의 기본값은 비용 0입니다(단위테스트와 검증 API가 이 값을 가정합니다). 실제 서버 실행(`server/app.js`)은 시작 시 다음 환경변수로 비용 모델을 구성해 주입합니다. 설정하지 않으면 대략적인 참고값이 적용됩니다.

```dotenv
PULSEHFT_PAPER_BUY_COMMISSION_BPS=1.40527
PULSEHFT_PAPER_SELL_COMMISSION_BPS=1.40527
PULSEHFT_PAPER_SELL_TAX_BPS=20
PULSEHFT_PAPER_SLIPPAGE_TICKS=1
```

- 매수·매도 수수료는 체결금액에 각각 bps로 부과되어 현금에서 추가로 차감(매수)되거나 체결대금에서 차감(매도)됩니다.
- 매수 수수료는 평균단가(cost basis)에 포함되고, 매도 수수료·세금은 실현손익에서 차감됩니다.
- 거래세는 매도 체결에만 부과됩니다.
- 슬리피지는 시장가(MARKET) 주문에만 적용되며, 설정된 틱 수만큼 불리한 방향(매수는 위, 매도는 아래)으로 체결가를 조정합니다. 지정가(LIMIT) 주문에는 적용하지 않습니다.
- 각 체결(`fill`) 객체에 `bookPrice`(호가창 원 가격), `price`(슬리피지 반영 체결가), `fee`, `tax` 필드가 기록되고, 계좌 스냅샷의 `totalFeesPaid`·`totalTaxPaid`로 누적 집계됩니다.
- **수수료·거래세율은 증권사·계좌 등급·법령 개정에 따라 달라집니다. 위 기본값은 참고용 추정치이며, 실제 사용 전 사용자의 실제 계좌 수수료율과 현재 세율로 반드시 재확인·대사해야 합니다.**

## 현재 반영하지 않는 항목

다음 항목은 검증된 기준이 정해지지 않았으므로 아직 체결 계산에 넣지 않습니다.

- 실제 주문 큐 순서
- 숨은 주문과 10호가 밖의 유동성
- 네트워크·증권사·거래소 지연
- 주문 접수 후 시세 변화
- 실제 부분 체결 통보 순서
- 정정 주문
- 장 운영시간과 동시호가 규칙

이 항목들은 한국투자증권 공식 모의투자 API의 실제 응답을 확인한 후 별도 단계에서 구현합니다.
