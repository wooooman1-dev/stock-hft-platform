# Roadmap

## Phase 1 — 시장 분석 기반 완료

- 실시간 대시보드와 10단계 호가·체결 시뮬레이터
- 시장 미세구조 지표와 신호 점수
- 기본 리스크 제한, 킬 스위치, 내부 모의 자동전략

## Phase 2 — 내부 모의체결·위험청산 완료

- 시장가 IOC, 지정가 GTC, 부분 체결, 주문 취소
- `clientOrderId` 멱등성, 현금·수량 예약, 포지션·손익
- 손절, 익절, 트레일링 스톱, 최대 보유시간
- 전략 설정 영구 저장과 결정적 검증 시장 틱
- append-only 실행 저널, fsync, 시작 시 무결성 검증

## Phase 3A — 한국투자 실전 현재가 읽기 전용 완료

- `PROD_READ_ONLY`
- 실전 OAuth 토큰 캐시
- 국내주식 현재가 조회
- 계좌·잔고·주문 경로 미구현
- 사용자 환경 실전 현재가 수동 검증 완료

## Phase 3B — 한국투자 모의투자 주문 구현 및 실계정 검증 완료

- 실전 키와 분리된 모의투자 자격정보 경계
- VTS 잔고 조회
- 모의 현금 매수·매도
- 정정취소 가능수량 선조회
- 모의 정정·취소
- 공통 주문 결과 정규화
- 명령 선기록과 `clientOrderId` 재시작 멱등성
- 네트워크·시간초과·5xx·비정상 응답 `UNKNOWN_RESULT`
- `UNKNOWN_RESULT` 수동 해소 절차 — 증권사 주문내역 교차검증 후 확정, 재시작 후에도 해소 상태 유지
- 수량·금액·일일 주문횟수·일일 손실 한도
- unknown_result 및 저널 오류 킬 스위치
- 자동전략 미연결
- 2026-08-21 모의투자 전용 키·계좌를 사용한 사용자 수동 검증 완료 (멱등성·정정·취소·재시작 재생·`UNKNOWN_RESULT` 발생과 해소)

## Phase 3C — 실제 시세 스트림

- WebSocket 승인키와 실제 호가·체결 정규화
- 누락·순서·지연 검사와 재연결
- 실제 틱·호가 append-only 저장
- REST 스냅샷 대사와 리플레이 검증
- 내부 분석 런타임 전환 전 장기 안정성 검증

## Phase 4 — 모의계좌 주문 상태 대사

- 주문내역·체결내역 조회 완료
- 접수·부분체결·전량체결·거절 상태 지속 동기화 완료 — 조회형(주문 제출·조회 시점) 갱신, 상시 백그라운드 폴러는 아님
- `UNKNOWN_RESULT` 수동 해소 절차 완료 — `BROKER_ORDER_UNKNOWN_RESOLVED` 이벤트와 주문내역 교차검증
- 주문 정정·취소 후 최종 상태 대사 완료 — 정정 수량·지정가, 취소 반영 여부를 대사 프레임워크로 확장
- 내부 체결모델과 증권사 모의체결 비교 완료 — 주문 제출 시점 KIS 10단계 호가 스냅샷을 내부 `PaperTrader` 매칭 엔진에 통과시켜 가상 체결과 실제 KIS 체결을 비교하는 진단 리포트(`GET /api/kis/paper/fill-comparison`). 예측·자동판정 아님, 두 시스템은 여전히 분리 운영
- 장 종료 정책과 연속 손실 제한 완료 — 연속 손실은 `BROKER_FILL_OBSERVED` 기반 FIFO 실현손익으로 킬 스위치 차단, 장 종료 보유포지션은 대시보드 알림 전용(자동 청산 없음, 사용자 결정)
- 실행 저널 기반 성과 통계·최대 낙폭 완료 — `BROKER_EQUITY_SNAPSHOT`·`BROKER_FILL_OBSERVED` 이벤트와 `GET /api/kis/paper/performance`

## Phase 5 — 검증과 실전 경계

- 수수료·세금·슬리피지 모델 완료 — 내부 `SIMULATION`(`PaperTrader`) 대상, 환경변수로 구성 가능한 참고 추정치. KIS 모의계좌는 브로커 응답의 `estimatedFeesAndTaxes`로 이미 실비용 반영됨
- 전략 버전 관리와 워크포워드 테스트 완료 — 설정 저장마다 append-only 이력(`GET /api/strategy/settings/history`, `POST /api/strategy/settings/restore/:version`) 기록, `scripts/walk-forward-backtest.js`가 실제 기록된 시장 데이터로 여러 설정 버전의 구간별 상대 성과를 비교(수동 실행, 실전 판정 아님)
- 반자동 승인 모드 완료 — `approvalMode: SEMI_AUTO`에서 신규 진입만 승인 대기(`GET/POST /api/strategy/pending-approvals`), 보호 청산·일반 매도는 항상 즉시 실행, 만료시간·중복요청 방지·실행저널 기록 포함. 내부 `SIMULATION`이 대시보드(`public/`)에 연결되지 않은 기존 설계(`strategySettingsPanel.js` 포함)와 동일하게 API·테스트로만 완결, 별도 UI 없음
- 장애 주입 검증 완료 — `server/test/kisPaperFaultInjection.test.js`가 실제 HTTP 계층(타임아웃·5xx·잘못된 JSON·명확한 거절 응답)을 주입해 UNKNOWN_RESULT 판정·킬 스위치·재시작 멱등 복원을 종단 간 검증
- 충분한 모의투자 기간 — 코드로 자동 판정하지 않음. `GET /api/kis/paper/performance`의 `operational.daysSinceLastIncident`로 마지막 사고 이후 경과일수를 참고 지표로만 노출하며, 실전 전환 가능 여부는 사용자가 직접 판단
- 사용자 별도 승인 전 실전 주문 구현 금지
- 사용자 별도 승인 후에도 최소금액 카나리부터 별도 설계

## Phase 6 — 실전 카나리 완료

- 사용자가 실계좌 자격정보 준비 완료·1주 카나리·모의투자와 동일한 리스크 한도 로직 재사용·이중 안전플래그를 명시적으로 승인한 뒤 구현
- 실전 시세 읽기 전용(`kisConfig.js`)·모의투자(`kisPaperConfig.js`)와 완전히 분리된 형제 파일 세트(`kisLiveConfig.js`, `kisLiveTradingClient.js`, `kisLiveOrderService.js` 등) — 매개변수화 대신 의도적 복제, 구조적 패리티 테스트(`kisLiveOrderServiceParity.test.js`)로 드리프트 방지
- 이중 안전플래그: `PULSEHFT_KIS_LIVE_MODE`(연결)와 `PULSEHFT_KIS_LIVE_ORDER_ENABLED`(주문 제출)를 분리해 둘 다 켜야만 실제 주문 가능
- 1주 하드 상한을 설정 로드 시점과 주문 처리 시점 두 곳에서 각각 강제
- 모의투자와 물리적으로 분리된 실행 저널(`execution-journal-live.jsonl`)과 토큰 파일(`kis-live-token.json`)로 두 계좌의 주문 상태·킬 스위치가 서로 섞이지 않음(`kisJournalIsolation.test.js`로 검증)
- 실전 TR ID(`TTTC*`)는 한국투자증권 공식 GitHub(`koreainvestment/open-trading-api`)의 `env_dv === "real"` 분기 값을 직접 확인해 채움(추정 금지)
- 모의투자와 동일한 대사(`KisLiveReconciler`)·성과 통계(`KisLivePerformanceTracker`)·장애 주입 검증(`kisLiveFaultInjection.test.js`)을 실전 계좌 전용으로 재구현
- `KisMainWorkspace`(모의투자 전용 오케스트레이터)를 거치지 않고 `app.js`에서 `/api/kis/live/*`로 직접 배선 — 종목 자동 선택·자동전략 연결 없음, API·테스트 전용, 대시보드 UI 없음
- 진단 전용 기능(`fill-comparison`)은 이번 카나리 범위에서 제외
- 실계좌 수동 검증은 아직 수행되지 않음 — `docs/KIS_LIVE_TRADING.md`의 검증 이력에 사용자가 직접 기록 예정
