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
- 주문·체결·취소·계좌 초기화 append-only JSONL 영구 저널
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

## 실행 저널

서버가 시작되면 다음 로컬 파일에 모의주문 생명주기를 append-only JSONL로 기록합니다.

```text
.pulsehft/execution-journal.jsonl
```

기록 대상은 세션 시작, 주문 생성, 주문 상태 변경, 체결, 모의계좌 초기화입니다. 기존 파일의 JSON이나 연속 순번이 손상된 경우 조용히 새 파일로 대체하지 않고 서버 시작을 중단합니다. 실행 중 기록 실패가 발생하면 킬 스위치를 켜고 자동전략을 끕니다.

API Key, App Secret, 접근 토큰, 실제 계좌번호와 환경변수 원문은 기록하지 않습니다. 상세 스키마와 오류 정책은 `docs/EXECUTION_JOURNAL.md`를 확인하세요.

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

## 검증 전용 시장 틱 API

손절·익절·트레일링 스톱을 무작위 가격 변동 없이 재현하기 위한 개발 검증 전용 경로입니다.

```text
POST /api/verification/market-tick
```

일반 실행에서는 경로가 존재하지 않는 것처럼 HTTP 404를 반환합니다. 서버 시작 전에 `PULSEHFT_ENABLE_VERIFICATION_API=true`를 명시하고 로컬 루프백 주소로 요청한 경우에만 사용할 수 있습니다.

검증 틱이 실제 적용되면 무작위 시장 타이머를 서버 재시작까지 정지하고, 해당 스냅샷의 `system.verificationMode`와 `system.marketTimerPaused`를 `true`로 표시합니다. 일반 모드 스냅샷에는 이 두 검증 전용 속성을 포함하지 않습니다.

```powershell
$env:PULSEHFT_ENABLE_VERIFICATION_API = "true"
npm start
```

결정적 위험청산 검증:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-risk-exits.ps1
```

검증이 끝나면 서버를 종료하고 환경변수를 제거한 뒤 일반 모드로 재시작합니다.

```powershell
Remove-Item Env:PULSEHFT_ENABLE_VERIFICATION_API -ErrorAction SilentlyContinue
npm start
```

## 디렉터리

```text
public/          브라우저 대시보드
server/domain/   분석·주문상태·모의체결·전략·리스크 엔진
server/test/     단위·런타임 테스트
scripts/         로컬 결정적 검증 스크립트
docs/            아키텍처·체결모델·전략설정·실행저널·로드맵
```
