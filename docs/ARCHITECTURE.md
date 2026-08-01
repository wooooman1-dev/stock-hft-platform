# PulseHFT Architecture

```text
MarketSimulator
  -> Atomic market snapshot
  -> Microstructure analysis
  -> Signal score
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

브라우저는 표시와 제어만 담당합니다. 분석·리스크·주문 상태·체결·계좌 상태는 서버가 소유합니다.

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
8. 실시간 연결 단절·시세 지연·주문 결과 불명 상태에서는 향후 신규 주문을 차단합니다.

## 안전 원칙

- 실제 시세 권한과 실제 주문 권한을 분리합니다.
- API 키·시크릿·계좌정보를 Git 또는 브라우저로 보내지 않습니다.
- 주문 요청·상태 변경·체결·취소를 향후 append-only 로그로 보존합니다.
- 리플레이와 증권사 모의투자 검증 없이 실주문 모드를 활성화하지 않습니다.
- 실계좌 주문은 별도 승인 없이는 구현하거나 활성화하지 않습니다.
