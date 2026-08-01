# PulseHFT

실시간 호가·체결 기반 시장 미세구조 분석과 모의 자동매매 플랫폼입니다.

> 주문은 현재 **내부 PAPER ONLY**입니다. 실제 증권사 주문은 연결되어 있지 않습니다.

## 시세 모드

### 내부 시뮬레이션

별도 키 없이 실행됩니다.

```dotenv
MARKET_MODE=simulation
```

### LS증권 Open API

LS증권 OAuth, `t1101` 초기 호가, WebSocket 실시간 호가·체결을 지원합니다. 실제 시세를 내부 모의매매와 결합합니다.

```dotenv
MARKET_MODE=ls
LS_ENVIRONMENT=paper
LS_MARKET=KOSPI
LS_APP_KEY=로컬에서만_입력
LS_APP_SECRET=로컬에서만_입력
```

상세 설정은 `docs/LS_OPEN_API_SETUP.md`를 확인하세요.

## 포함 기능

- 내부 시뮬레이션 또는 LS증권 실시간 시세 공급자
- 10단계 호가와 실시간 체결
- 1초봉 가격 차트
- 가중 호가 불균형, 체결 흐름, 거래 속도, 스프레드, 모멘텀, 변동성
- 매수·매도·관망 신호 점수와 판단 근거
- 내부 모의 시장가 주문과 손익 계산
- 내부 모의 자동전략
- 최대 주문·최대 포지션·손실 한도
- 킬 스위치
- SSE 기반 실시간 대시보드
- 외부 패키지 의존성 없음

## 실행

Node.js 22 이상이 필요합니다. `npm install`은 필요하지 않습니다.

```powershell
Copy-Item .env.example .env
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

## 디렉터리

```text
public/                 브라우저 대시보드
server/domain/          분석·모의주문·런타임
server/market/          공통 시장 데이터 공급자
server/brokers/ls/      LS증권 OAuth·REST·WebSocket 어댑터
docs/                   아키텍처·설정·로드맵
```
