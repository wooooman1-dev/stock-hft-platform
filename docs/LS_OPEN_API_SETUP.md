# LS증권 Open API 연결 설정

## 현재 구현 범위

- OAuth 접근토큰 발급
- REST `t1101` 현재가·10단계 호가 초기 조회
- WebSocket 실시간 호가와 체결 구독
  - KOSPI: `H1_`, `S3_`
  - KOSDAQ: `HA_`, `K3_`
  - 통합: `UH1`, `US3`
- 실시간 데이터를 PulseHFT 공통 호가·체결 구조로 정규화
- 기존 미세구조 분석과 내부 모의매매에 연결
- 시세 연결 실패 상태와 오류를 대시보드/health API에 표시

실제 증권사 주문은 아직 구현하지 않았습니다. `LS_ENVIRONMENT=live`도 운영 시세를 의미할 뿐, 주문은 계속 PulseHFT 내부 모의체결입니다.

## LS증권 측 준비

1. LS증권 계좌 개설
2. 홈페이지에서 XingAPI 사용등록
3. OPEN API 사용신청
4. 모의투자를 사용할 경우 모의투자 OPEN API도 별도 신청
5. 발급된 App Key와 App Secret을 로컬 `.env`에만 저장

App Key와 App Secret은 Git에 커밋하거나 채팅에 붙여넣지 않습니다.

## 로컬 설정

프로젝트 루트에서:

```powershell
Copy-Item .env.example .env
notepad .env
```

모의투자 시세 연결 예시:

```dotenv
MARKET_MODE=ls
LS_ENVIRONMENT=paper
LS_MARKET=KOSPI
LS_APP_KEY=로컬에_발급키_입력
LS_APP_SECRET=로컬에_시크릿_입력
DEFAULT_SYMBOL=005930
DEFAULT_SYMBOL_NAME=삼성전자
DEFAULT_PRICE=70000
```

실행:

```powershell
npm start
```

확인:

```powershell
Invoke-RestMethod http://localhost:8787/health
```

정상 연결 시 `provider`는 `LS_SECURITIES`, `feedConnected`는 `true`로 표시됩니다.

## 공식 접속점

- REST/OAuth: `https://openapi.ls-sec.co.kr:8080`
- 운영 WebSocket: `wss://openapi.ls-sec.co.kr:9443/websocket`
- 모의투자 WebSocket: `wss://openapi.ls-sec.co.kr:29443/websocket`

## 안전 경계

- LS 시세와 내부 모의주문을 명확히 분리합니다.
- 실계좌 주문 API는 별도 기능 브랜치에서 구현합니다.
- 모의투자 주문 검증 전에는 실계좌 주문 모드를 추가하지 않습니다.
- 키·시크릿·계좌 비밀번호는 서버 환경변수에서만 읽습니다.
