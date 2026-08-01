# KIS PROD_READ_ONLY

PulseHFT의 첫 한국투자증권 연결 단계는 실전투자 App Key를 사용한 **시세 조회 전용 모드**입니다.

```text
PULSEHFT_KIS_MODE=PROD_READ_ONLY
```

이 모드는 실제 계좌 주문 모드가 아닙니다. 계좌번호를 저장하지 않으며 주문·정정·취소·잔고 API를 제공하지 않습니다.

## 공식 API 범위

```text
REST base URL
https://openapi.koreainvestment.com:9443

OAuth 접근토큰
POST /oauth2/tokenP

국내주식 현재가
GET /uapi/domestic-stock/v1/quotations/inquire-price
TR ID: FHKST01010100
```

현재가 조회의 시장 구분은 다음만 허용합니다.

```text
J  KRX
NX NXT
UN 통합
```

## 기본 상태

환경변수를 지정하지 않은 일반 실행에서는 한국투자 연동이 비활성화됩니다.

```text
mode: DISABLED
quoteApiAvailable: false
orderApiAvailable: false
accountConfigured: false
```

활성화 상태에서도 기존 `MarketRuntime`은 계속 `SIMULATION`입니다. 한국투자 현재가는 별도 읽기 전용 API로만 조회되며 자동전략이나 PaperTrader의 입력으로 사용되지 않습니다.

## `.env` 자격정보 설정

App Key와 App Secret을 채팅, Git, 브라우저 또는 실행 저널에 입력하지 않습니다.

프로젝트 루트의 `.env` 파일에 다음 세 줄만 저장합니다.

```dotenv
PULSEHFT_KIS_MODE=PROD_READ_ONLY
PULSEHFT_KIS_APP_KEY=발급받은_실전_APP_KEY
PULSEHFT_KIS_APP_SECRET=발급받은_실전_APP_SECRET
```

`.env`는 Git에서 제외되며, 저장소에는 실제 비밀값이 없는 `.env.example`만 포함됩니다. `.env`는 평문 로컬 파일이므로 Windows 계정과 프로젝트 폴더 접근 권한을 안전하게 유지해야 합니다.

계좌 관련 환경변수는 허용하지 않습니다. 다음 값이 존재하면 서버 시작 단계에서 거절합니다.

```text
PULSEHFT_KIS_ACCOUNT_NUMBER
PULSEHFT_KIS_ACCOUNT_PRODUCT_CODE
PULSEHFT_KIS_HTS_ID
```

실행:

```powershell
npm run start:kis:prod-read-only
```

이 명령은 Node.js 22의 `--env-file=.env` 기능으로 환경변수를 로드합니다. 일반 `npm start`는 `.env`를 자동으로 읽지 않으므로 한국투자 연결은 기본적으로 비활성 상태를 유지합니다.

기존 JSON 자격정보 방식도 하위 호환으로 남아 있지만, `.env`에 App Key와 App Secret이 모두 있으면 `.env` 값이 우선됩니다. 둘 중 하나만 설정된 경우에는 시작을 거절합니다.

## 토큰 정책

토큰은 다음 파일에 저장됩니다.

```text
.pulsehft/kis-prod-token.json
```

- 만료 1분 전까지 기존 토큰을 재사용합니다.
- 동시에 여러 조회가 시작돼도 토큰 발급 요청은 하나로 합칩니다.
- 토큰 파일의 JSON·스키마가 손상되면 서버 시작을 중단합니다.
- 토큰·App Key·App Secret은 API 응답, 실행 저널, 오류 메시지에 포함하지 않습니다.
- 토큰 발급 요청에 실패해도 자격정보 원문을 로그로 출력하지 않습니다.

## 로컬 API

한국투자 관련 경로는 서버가 `0.0.0.0`에 바인딩되어 있더라도 루프백 요청만 허용합니다. 다른 컴퓨터에서 접근하면 존재하지 않는 경로처럼 `404`를 반환합니다.

```text
GET /api/kis/status
GET /api/kis/quote?symbol=005930&market=UN
```

현재가 예시 응답:

```json
{
  "source": "KIS",
  "mode": "PROD_READ_ONLY",
  "environment": "PROD",
  "currency": "KRW",
  "symbol": "005930",
  "market": "UN",
  "currentPrice": 70000,
  "changePercent": 1.45,
  "accumulatedVolume": 1234567
}
```

다음 경로는 구현하지 않습니다.

```text
/api/kis/orders
/api/kis/order
/api/kis/account
/api/kis/balance
```

`/api/kis/status`와 `/api/kis/quote` 이외의 한국투자 경로는 모두 `404 KIS_READ_ONLY_ROUTE_NOT_FOUND`입니다.

## 현재 제한

- REST 현재가 단건 조회만 지원합니다.
- WebSocket 실시간 호가·체결은 아직 연결하지 않습니다.
- 한국투자 시세를 기존 분석 런타임에 주입하지 않습니다.
- 계좌조회와 주문은 지원하지 않습니다.
- 실전 주문 모드는 존재하지 않습니다.
- 모의투자 주문 연결은 별도 Phase에서 구현합니다.
