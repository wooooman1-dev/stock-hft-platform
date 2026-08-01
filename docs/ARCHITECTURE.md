# PulseHFT Architecture

```text
MarketDataSource
  ├─ SimulationMarketDataSource
  └─ LsMarketDataSource
       ├─ LsAuthClient (OAuth)
       ├─ LsRestClient (t1101 initial snapshot)
       └─ LsRealtimeClient (H1_/S3_, HA_/K3_, UH1/US3)
            ↓
Normalized market tick
  -> Microstructure analysis
  -> Signal score
  -> Internal paper strategy / manual paper order
  -> Risk checks
  -> Internal paper execution
  -> Node HTTP REST + Server-Sent Events
  -> Browser dashboard
```

브라우저는 표시와 제어만 담당합니다. 인증키, 시세 정규화, 분석, 리스크, 모의주문 상태는 서버가 소유합니다.

## 증권사 연결 경계

시장 데이터 공급자는 공통 이벤트 계약을 사용합니다.

```js
class MarketDataSource {
  mode;
  provider;
  connected;
  tickSize;
  async start() {}
  stop() {}
  // events: tick, status, error
}
```

향후 주문 연결은 시세 공급자와 분리된 계약으로 구현합니다.

```js
class BrokerOrderAdapter {
  async submitOrder(order) {}
  async cancelOrder(orderId) {}
  async getOrders() {}
  async getPositions() {}
}
```

## 안전 원칙

1. 실시간 데이터 권한과 주문 권한을 분리합니다.
2. 현재 LS 연동은 시세 전용이며 주문은 내부 모의체결입니다.
3. 모든 주문 직전에 서버 측 리스크 검사를 수행합니다.
4. 킬 스위치는 전략보다 우선합니다.
5. 주문 요청·응답·체결·정정·취소는 향후 append-only 로그로 보존합니다.
6. 연결 단절, 시세 지연, 주문 결과 불명 상태에서는 신규 주문을 차단합니다.
7. 리플레이와 증권사 모의투자 검증 없이 실주문 모드를 활성화하지 않습니다.
