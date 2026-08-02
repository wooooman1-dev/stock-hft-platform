# 매수추천 리스트 — 후보 스캐너와 실시간 확인

## 목적

메인 화면의 `매수추천` 버튼에서 시장 후보를 순위화하고 KIS WebSocket 호가·체결로 실시간 상태를 추가 확인합니다.

이 기능은 자동주문 기능이 아닙니다. `ENTRY_READY`가 표시되더라도 내부 자동전략, KIS 모의주문, KIS 실전 주문으로 연결되지 않습니다.

## 데이터 흐름

1. KIS 거래대금 순위
2. KIS 등락률 순위
3. KIS 체결강도 순위
4. 상위 후보 현재가
5. 상위 후보 10단계 REST 호가 스냅샷
6. 상위 후보 당일 분봉
7. OpenDART 최근 공시 위험 필터(키 설정 시)
8. NAVER API HUB 뉴스·카페 검색 보조정보(키 설정 시)
9. KIS WebSocket 실시간 호가·체결 확인

KIS REST 호출은 순차 실행하고 호출 사이 기본 1000ms 간격을 둡니다. 전 종목을 반복 현재가 조회하지 않고 순위 API로 1차 후보를 줄인 뒤 정밀 분석합니다.

실시간 WebSocket은 정밀 분석한 상위 후보만 구독합니다. KRX, NXT, 통합 호가·체결 TR을 지원하며 상세 규격과 안전 기준은 `docs/KIS_REALTIME_MARKET_DATA.md`에 기록합니다.

## 후보 유형

- `PULLBACK`: 상승 추세 속 짧은 눌림 후 재상승
- `REVERSAL`: 매도 압력 약화 뒤 가격 반등 후보

## REST 분석 상태

- `CONFIRMATION_REQUIRED`: 점수 기준을 통과했지만 실시간 체결·호가 확인 필요
- `WATCH`: 감시 후보
- `LOW_PRIORITY`: 우선순위 낮음
- `BLOCKED`: 거래대금·분봉·호가·스프레드·시세지연·중요 위험공시 중 하나로 차단

## 실시간 확인 상태

- `SCANNED`: REST 후보만 생성되고 실시간 확인 서비스가 없음
- `WATCH`: 실시간 데이터는 최신이지만 확인 조건 일부가 기준 미달
- `REALTIME_CONFIRMING`: 연결됐으나 호가 또는 체결 수신을 기다리는 중
- `ENTRY_READY`: REST 확인 대상이며 최신 실시간 안전 조건을 통과
- `BLOCKED`: REST 차단 또는 실시간 거래정지·스프레드·추격 제한 위반
- `STALE`: 호가 또는 체결 데이터 지연
- `DISCONNECTED`: WebSocket 연결 단절

`ENTRY_READY`는 수익성이 입증된 매수 신호가 아니라 실시간 확인을 통과한 임시 분석 상태입니다.

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

키가 없으면 해당 데이터 공급원만 `NOT_CONNECTED`로 표시되고 KIS 후보 목록과 WebSocket 확인은 계속 작동합니다.

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
PULSEHFT_RECOMMENDATION_REQUEST_SPACING_MS=1000
```

## API

- `GET /api/recommendations`: 캐시가 오래됐으면 갱신 후 목록 반환
- `POST /api/recommendations/refresh`: 강제 갱신
- `/health`의 `recommendations`: REST·WebSocket·보조 데이터 연결 상태

세 경로 모두 기존 서버의 로컬 루프백 경계를 따릅니다.

응답에는 후보별 `realtime.state`와 실시간 현재가·스프레드·호가 불균형·체결강도·가중평균가 이격·VI 기준가가 포함됩니다.

## 주문 안전 경계

다음 연결은 구현하지 않습니다.

- 추천 후보 선택 → 주문 제출
- `ENTRY_READY` → 내부 자동전략 주문
- `ENTRY_READY` → KIS 모의주문
- `ENTRY_READY` → KIS 실전 주문
- WebSocket 실패 → 주문 자동 재시도

`executionBoundary.automaticOrderConnected`는 `false`, `actionableStages`는 빈 배열, `realtimeEntryReadyIsOrderSignal`은 `false`로 유지합니다.

## 남은 실제 검증

- 정규 장중 실제 WebSocket 접속키 발급과 구독 승인
- 실제 KRX·NXT·통합 호가·체결 수신
- 30분 이상 반복 운용
- 단절·재연결·stale 상태 전이
- 후보 교체 시 구독 해제·재등록
- 기록·재생 기반 임계값 검증

위 검증 전에는 실시간 조건과 `ENTRY_READY`를 최종 자동매매 기준으로 확정하지 않습니다.
