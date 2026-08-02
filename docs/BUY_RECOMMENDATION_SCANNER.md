# 매수추천 리스트 — 1차 후보 스캐너

## 목적

메인 화면의 `매수추천` 버튼에서 시장 후보를 순위화합니다.
이 기능은 자동주문 기능이 아닙니다. 실시간 WebSocket 전환 확인이 구현되기 전에는 모든 후보가 분석·감시 용도입니다.

## 데이터 흐름

1. KIS 거래대금 순위
2. KIS 등락률 순위
3. KIS 체결강도 순위
4. 상위 후보 현재가
5. 상위 후보 10단계 호가 스냅샷
6. 상위 후보 당일 분봉
7. OpenDART 최근 공시 위험 필터(키 설정 시)
8. NAVER API HUB 뉴스·카페 검색 보조정보(키 설정 시)

KIS REST 호출은 순차 실행하고 호출 사이 간격을 둡니다. 전 종목을 반복 현재가 조회하지 않고 순위 API로 1차 후보를 줄인 뒤 정밀 분석합니다.

## 후보 유형

- `PULLBACK`: 상승 추세 속 짧은 눌림 후 재상승
- `REVERSAL`: 매도 압력 약화 뒤 가격 반등 후보

## 상태

- `CONFIRMATION_REQUIRED`: 점수 기준을 통과했지만 실시간 체결·호가 확인 필요
- `WATCH`: 감시 후보
- `LOW_PRIORITY`: 우선순위 낮음
- `BLOCKED`: 거래대금·분봉·호가·스프레드·시세지연·중요 위험공시 중 하나로 차단

중요 위험공시는 후보를 차단합니다. 뉴스와 커뮤니티 검색 결과는 점수나 매수 판단에 직접 반영하지 않습니다.

## 비용 모델

기본값은 설정 가능한 추정치입니다.

- 목표 순수익: 3% (`300 bps`)
- 매수 수수료: `1.40527 bps`
- 매도 수수료: `1.40527 bps`
- 매도세금: `20 bps`
- 예상 슬리피지: `1틱`

실제 자동매매 전에는 반드시 계좌별 적용 수수료와 증권사 체결 정산 결과로 대사해야 합니다.

## 선택적 API 설정

기존 `.env`에 필요한 값만 추가합니다. 값은 Git에 커밋하지 않습니다.

```dotenv
# OpenDART 공시 위험 필터
PULSEHFT_DART_API_KEY=

# NAVER API HUB 뉴스·카페 검색
PULSEHFT_NAVER_API_HUB_CLIENT_ID=
PULSEHFT_NAVER_API_HUB_CLIENT_SECRET=
```

키가 없으면 해당 데이터 공급원만 `NOT_CONNECTED`로 표시되고 KIS 후보 목록은 계속 작동합니다.

## 추천 설정 환경변수

```dotenv
PULSEHFT_RECOMMENDATION_CACHE_TTL_MS=15000
PULSEHFT_RECOMMENDATION_MAX_UNIVERSE=30
PULSEHFT_RECOMMENDATION_MAX_ENRICHED=8
PULSEHFT_RECOMMENDATION_MIN_TRADING_VALUE=1000000000
PULSEHFT_RECOMMENDATION_TARGET_NET_BPS=300
PULSEHFT_RECOMMENDATION_BUY_FEE_BPS=1.40527
PULSEHFT_RECOMMENDATION_SELL_FEE_BPS=1.40527
PULSEHFT_RECOMMENDATION_SELL_TAX_BPS=20
PULSEHFT_RECOMMENDATION_SLIPPAGE_TICKS=1
PULSEHFT_RECOMMENDATION_REQUEST_SPACING_MS=120
```

## API

- `GET /api/recommendations`: 캐시가 오래됐으면 갱신 후 목록 반환
- `POST /api/recommendations/refresh`: 강제 갱신
- `/health`의 `recommendations`: 데이터 공급원과 캐시 상태

세 경로 모두 기존 서버의 로컬 루프백 경계를 따릅니다.

## 아직 자동매수로 연결하지 않는 이유

REST 호가와 분봉은 1차 후보 선별에는 사용할 수 있지만, 다음 항목을 확정하지 못합니다.

- 실시간 매도 압력 감소
- 실시간 매수 체결 전환
- 호가 생성·취소 변화
- 신호 직후 급락 또는 추격매수 여부

다음 단계에서 KIS 실시간 체결·호가 WebSocket을 붙이고, 후보를 `WATCH → ARMED → TRIGGERED` 상태로 승격하는 검증이 필요합니다.
