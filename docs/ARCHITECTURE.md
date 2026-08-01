# PulseHFT Architecture

```text
MarketSimulator
  -> Atomic market snapshot
  -> Microstructure analysis
  -> Signal score
  -> StrategySettings
  -> PositionRiskTracker
       ├─ first openedAt
       └─ peak lastPrice
  -> Entry / signal-exit / protective-exit intent
  -> Manual / strategy order request
  -> Risk and reservation checks
  -> Paper order lifecycle
       ├─ clientOrderId idempotency
       ├─ MARKET IOC depth matching
       ├─ LIMIT GTC depth matching
       ├─ partial fills
       ├─ cancellation
       └─ position / cash accounting
  -> Node HTTP REST + Server-Sent Events
  -> Browser dashboard
```

브라우저는 표시와 제어만 담당합니다. 분석·전략 설정·포지션 위험 추적·주문 상태·체결·계좌 상태는 서버가 소유합니다.

## 전략 위험청산 경계

`strategyPolicy.js`는 주문을 직접 체결하지 않고 청산 의도만 반환합니다. 손절·트레일링 스톱·익절·최대 보유시간·일반 매도신호의 우선순위를 결정하며, 실제 주문과 취소는 `MarketRuntime`이 수행합니다.

전략 청산 순서:

```text
1. 자동전략 ON·킬 스위치 OFF 확인
2. 위험청산 또는 일반 매도신호 평가
3. 열린 매수·매도 지정가 주문 전부 취소
4. 최신 전체 보유수량 확인
5. 전체 수량 시장가 IOC 제출
6. PaperTrader가 표시된 매수호가만 사용해 체결
7. 포지션이 0이면 PositionRiskTracker 초기화
```

열린 주문을 먼저 취소하는 이유는 매도 예약 때문에 전체 청산이 거절되는 문제와, 청산 직후 대기 매수 주문이 체결돼 포지션이 다시 생기는 문제를 동시에 막기 위해서입니다.

## 주문 경계

현재 내부 주문 엔진과 향후 증권사 주문 어댑터를 분리합니다.

```js
class OrderAdapter {
  async submitOrder(order) {}
  async cancelOrder(orderId) {}
  async getOrder(orderId) {}
  async getOpenOrders() {}
}
```

내부 모의체결은 `PaperTrader`가 담당합니다. 한국투자증권 연결 시 같은 상위 주문 명령을 실제 모의투자 주문 어댑터로 전달하되, 증권사 응답 상태를 내부 공통 상태로 정규화합니다.

## 불변 조건

1. 동일한 `clientOrderId` 주문은 한 번만 실행합니다.
2. 열린 매수 주문은 현금을 예약합니다.
3. 열린 매도 주문은 보유수량을 예약합니다.
4. 주문 체결 합계는 요청수량을 초과할 수 없습니다.
5. `filled + remaining + cancelled + rejected = requested`를 유지합니다.
6. 킬 스위치는 신규 수동·자동 주문보다 우선합니다.
7. 모의체결은 표시된 호가 잔량을 초과해 유동성을 생성하지 않습니다.
8. 전략 청산은 열린 주문 취소 후 최신 전체 보유수량을 사용합니다.
9. 포지션 수량이 0이 되면 보유 시작시각과 최고가격을 초기화합니다.
10. 실시간 연결 단절·시세 지연·주문 결과 불명 상태에서는 향후 신규 주문을 차단합니다.

## 저장 경계

전략 설정은 `.pulsehft/strategy-settings.json`에 저장합니다. 다음 항목은 저장하지 않습니다.

- 자동전략 활성화 상태
- 모의 주문과 체결
- 모의 포지션
- 보유 시작시각
- 트레일링 최고가격

따라서 서버 재시작 후 전략 설정값만 복원되고 자동전략과 모의계좌는 초기 상태로 시작합니다.

## 안전 원칙

- 실제 시세 권한과 실제 주문 권한을 분리합니다.
- API 키·시크릿·계좌정보를 Git 또는 브라우저로 보내지 않습니다.
- 주문 요청·상태 변경·체결·취소를 향후 append-only 로그로 보존합니다.
- 리플레이와 증권사 모의투자 검증 없이 실주문 모드를 활성화하지 않습니다.
- 실계좌 주문은 별도 승인 없이는 구현하거나 활성화하지 않습니다.
