# PulseHFT Architecture

```text
MarketSimulator (SIMULATION)
  -> Normalized market tick
  -> Microstructure analysis
  -> Signal score
  -> Paper strategy / manual paper order
  -> Risk checks
  -> Paper execution
  -> Node HTTP REST + Server-Sent Events
  -> Browser dashboard
```

브라우저는 표시와 제어만 담당합니다. 분석·리스크·주문 상태는 서버가 소유합니다.

## 실제 증권사 연결 경계

현재 `MarketSimulator`를 다음 계약을 따르는 `BrokerAdapter`로 교체합니다.

```js
class BrokerAdapter {
  async connectMarketData(symbols) {}
  onOrderBook(handler) {}
  onTrade(handler) {}
  async submitOrder(order) {}
  async cancelOrder(orderId) {}
  async getPositions() {}
}
```

## 안전 원칙

1. 실시간 데이터 권한과 주문 권한을 분리합니다.
2. 모든 주문 직전에 서버 측 리스크 검사를 수행합니다.
3. 킬 스위치는 전략보다 우선합니다.
4. 주문 요청·응답·체결·정정·취소를 append-only 로그로 보존합니다.
5. 연결 단절, 시세 지연, 주문 결과 불명 상태에서는 신규 주문을 차단합니다.
6. 리플레이와 모의투자 검증 없이 실주문 모드를 활성화하지 않습니다.
