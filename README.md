# PulseHFT

실시간 호가·체결 기반 시장 미세구조 분석과 **호가 기반 모의주문**을 하나의 서버 중심 구조로 구현한 개발 버전입니다.

> 현재는 **SIMULATION / INTERNAL PAPER ONLY**입니다. 실제 증권사 시세·계좌·주문은 연결되어 있지 않습니다.

## 포함 기능

- 10단계 호가와 실시간 체결 시뮬레이션
- 1초봉 가격 차트
- 가중 호가 불균형, 체결 흐름, 거래 속도, 스프레드, 모멘텀, 변동성
- 매수·매도·관망 신호 점수와 판단 근거
- 시장가 IOC와 지정가 GTC 모의주문
- 표시된 호가 잔량을 순서대로 소비하는 다단계 체결
- 부분 체결, 미체결 잔량 취소, 지정가 대기·취소
- `clientOrderId` 기반 중복 주문 방지
- 미체결 매수금액과 매도수량 예약
- 포지션·평균단가·평가손익·실현손익
- 주문별 상태 이벤트와 체결 기록
- 모의 자동전략과 킬 스위치
- 자동전략 설정 화면과 로컬 영구 저장
- 선택형 손절·익절·트레일링 스톱·최대 보유시간
- 포지션 최초 진입시각과 보유 중 최고가격 추적
- 전략 청산 전 열린 주문 취소와 전체 포지션 시장가 IOC 청산
- 최대 주문·최대 포지션·손실 한도
- SSE 기반 실시간 대시보드
- 외부 패키지 의존성 없음

위험청산 네 항목은 기본값이 모두 `OFF`이며, 사용자가 값을 입력하고 저장한 항목만 작동합니다. 자동전략 활성화 상태는 저장하지 않으므로 서버 재시작 후 항상 `OFF`로 시작합니다.

## 모의체결 범위

현재 모의체결은 화면에 표시된 10단계 호가만 사용합니다.

- 시장가: 반대편 호가를 최우선 가격부터 소비하는 `IOC`
- 지정가: 가격이 교차하면 체결하고 잔량은 `GTC` 대기
- 수수료·세금: 아직 미반영
- 실제 주문 큐 순서·숨은 유동성: 미반영
- 지정가 대기 주문: 반대편 표시호가가 지정가격과 교차할 때 체결
- 전략 청산: 열린 주문을 먼저 취소한 뒤 전체 보유수량을 시장가 IOC로 제출

세부 규칙과 한계는 `docs/PAPER_EXECUTION_MODEL.md`와 `docs/STRATEGY_SETTINGS.md`를 확인하세요.

## 실행

Node.js 22 이상만 있으면 됩니다. `npm install`은 필요하지 않습니다.

```powershell
npm start
```

브라우저에서 `http://localhost:8787`을 엽니다.

개발 중 파일 변경 자동 재시작:

```powershell
npm run dev
```

검증:

```powershell
npm run check
```

## API

```text
GET  /health
GET  /api/snapshot
GET  /api/events
GET  /api/strategy/settings
PUT  /api/strategy/settings
POST /api/strategy/settings/reset
POST /api/paper/orders
POST /api/paper/orders/:orderId/cancel
POST /api/paper/reset
POST /api/strategy/auto
POST /api/system/kill-switch
```

결정적 위험청산 검증이 필요한 경우에만 서버 시작 전에 `PULSEHFT_ENABLE_VERIFICATION_API=true`를 설정할 수 있습니다. 이때도 로컬 루프백 요청만 `POST /api/verification/market-tick`에 접근할 수 있으며 일반 실행에서는 HTTP 404를 반환합니다. 세부 사용법은 `docs/STRATEGY_SETTINGS.md`를 확인하세요.

시장가 주문 예시:

```json
{
  "side": "BUY",
  "type": "MARKET",
  "quantity": 10,
  "clientOrderId": "my-order-0001"
}
```

지정가 주문 예시:

```json
{
  "side": "BUY",
  "type": "LIMIT",
  "quantity": 10,
  "limitPrice": 70000,
  "clientOrderId": "my-order-0002"
}
```

## 디렉터리

```text
public/          브라우저 대시보드
server/domain/   분석·주문상태·모의체결·전략·리스크 엔진
server/test/     단위·런타임 테스트
docs/            아키텍처·체결모델·전략설정·로드맵
```
