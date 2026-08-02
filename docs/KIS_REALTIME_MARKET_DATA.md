# KIS WebSocket 실시간 호가·체결 확인

## 목적

매수추천 스캐너가 KIS REST 순위·현재가·호가·분봉으로 만든 후보를 한국투자증권 WebSocket 실시간 호가와 체결로 추가 확인합니다.

이 기능은 분석 전용입니다. `ENTRY_READY`가 표시되더라도 KIS 모의주문, 실전 주문, 내부 자동전략과 연결되지 않습니다.

## 공식 실시간 TR

| 구분 | 호가 | 체결 |
| --- | --- | --- |
| KRX | `H0STASP0` | `H0STCNT0` |
| NXT | `H0NXASP0` | `H0NXCNT0` |
| 통합 | `H0UNASP0` | `H0UNCNT0` |

실전 WebSocket 접속 주소는 `ws://ops.koreainvestment.com:21000/tryitout`이며, 기존 실전 시세 읽기 전용 App Key·App Secret으로 `/oauth2/Approval` 접속키를 발급받습니다.

접속키, App Key, App Secret은 API 응답, 상태 객체, 로그, 실행 저널에 원문으로 넣지 않습니다.

## 구독 범위

추천 스캐너가 정밀 분석한 상위 후보만 구독합니다. 기본 최대 종목 수는 기존 `PULSEHFT_RECOMMENDATION_MAX_ENRICHED` 값과 같으며 기본값은 8개입니다.

각 종목마다 호가 TR과 체결 TR을 함께 등록하고, 추천 후보가 바뀌면 제외된 종목을 구독 해제한 뒤 새 후보를 구독합니다.

## 상태 모델

- `SCANNED`: REST 후보만 생성됐고 실시간 서비스가 아직 없음
- `WATCH`: 실시간 데이터는 최신이지만 호가 불균형·체결강도 또는 REST 점수가 기준 미달
- `REALTIME_CONFIRMING`: 연결됐으나 호가 또는 체결 중 하나를 아직 기다리는 중
- `ENTRY_READY`: REST 확인 대상이며 최신 호가·체결의 1차 안전 조건을 통과
- `BLOCKED`: REST 차단, 거래정지, 스프레드 초과, 추격 이격 초과 등
- `STALE`: 호가 또는 체결 데이터가 기본 5초 이상 지연
- `DISCONNECTED`: WebSocket 연결 단절

`ENTRY_READY`는 수익성이 검증된 매수 신호가 아니라 실시간 확인을 통과한 임시 분석 상태입니다.

## 1차 실시간 안전 기준

- 호가와 체결이 모두 기본 5초 이내 최신
- 스프레드 25bp 이하
- 매수호가 불균형 5% 이상
- 체결강도 100 이상
- 현재가가 실시간 가중평균가보다 150bp 초과 상승한 추격 구간이 아님
- 거래정지 상태가 아님
- REST 단계가 `CONFIRMATION_REQUIRED`

이 값들은 장중 기록·재생과 성과 검증 전의 보수적 초기 기준입니다. 자동매매 확정 기준으로 간주하지 않습니다.

## 연결과 복구

- KIS PINGPONG 메시지를 원문 그대로 회신
- 연결 단절 시 1초부터 최대 30초까지 지수 백오프로 재연결
- 재연결 후 현재 추천 후보를 다시 구독
- 실시간 호가와 체결의 수신 시각을 각각 추적
- 승인키는 최대 23시간 동안 메모리에서 재사용

## 화면과 API

`GET /api/recommendations` 응답에 다음이 추가됩니다.

- 후보별 `realtime.state`
- 실시간 현재가, 스프레드, 호가 불균형, 체결강도, 가중평균가 이격, VI 기준가
- `realtimeStateCounts`
- `status.dataSources.realtime`

화면의 열 수와 기존 가로 스크롤은 유지합니다. 상태 열에서 실시간 상태를 표시합니다.

## 주문 경계

다음 연결은 구현하지 않습니다.

- `ENTRY_READY` → 내부 자동전략 주문
- `ENTRY_READY` → KIS 모의주문
- `ENTRY_READY` → KIS 실전 주문
- WebSocket 오류 또는 단절에 대한 주문 재시도

응답의 `automaticOrderConnected`는 계속 `false`이고 `actionableStages`는 빈 배열입니다.

## 검증

```powershell
cd F:\Project\stock-hft-platform
npm run check
npm run start:kis:prod-read-only
```

서버 실행 후 추천 목록을 새로고침하고 다음을 확인합니다.

```powershell
Invoke-RestMethod http://localhost:8787/api/recommendations | ConvertTo-Json -Depth 12
```

확인 항목:

- `status.dataSources.realtime.connected`
- `status.dataSources.realtime.activeSubscriptionCount`
- 후보별 `realtime.state`
- 호가와 체결의 `receivedAt`
- App Key·App Secret·approval key 원문 미노출
- 연결 단절 시 `DISCONNECTED`, 데이터 지연 시 `STALE`

일요일·장 마감 시간에는 WebSocket 연결이 성공하더라도 실시간 체결이 오지 않아 `REALTIME_CONFIRMING` 또는 `STALE`로 남을 수 있습니다. 실제 `ENTRY_READY` 검증은 정규 장중 데이터로 진행해야 합니다.
