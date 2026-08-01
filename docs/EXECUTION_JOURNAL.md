# Execution Journal

PulseHFT는 모의주문의 생성·상태 변경·체결·계좌 초기화를 로컬 append-only JSONL 파일에 기록합니다.

```text
.pulsehft/execution-journal.jsonl
```

`PULSEHFT_DATA_DIR`을 지정한 경우에는 해당 디렉터리 아래에 생성됩니다.

## 목적

- 서버 재시작 후 주문·체결 이력 분석 기반 제공
- 일일 거래 횟수와 연속 손실 계산 기반 제공
- 성과 통계와 최대 낙폭 계산 기반 제공
- 향후 한국투자증권 모의투자 주문 상태와 내부 주문 상태 대사
- 주문 결과 불명 상태 조사

현재 저널은 계좌와 주문 상태를 자동 복원하지 않습니다. 복원이 아니라 검증 가능한 이력 보존이 첫 목적입니다.

## 기록 이벤트

```text
SESSION_STARTED
ORDER_CREATED
ORDER_EVENT
FILL
ACCOUNT_RESET
```

각 행은 다음 공통 필드를 가집니다.

```json
{
  "schemaVersion": 1,
  "eventId": "...",
  "sessionId": "...",
  "sequence": 1,
  "timestamp": 0,
  "type": "SESSION_STARTED",
  "payload": {}
}
```

- 파일의 행 순서가 전체 이벤트 순서입니다.
- `sequence`는 파일 첫 행의 1부터 연속 증가해야 합니다.
- 서버를 재시작하면 `sessionId`는 바뀌지만 `sequence`는 기존 파일 다음 값부터 이어집니다.
- 주문 재전송이 `clientOrderId` 멱등 재생으로 처리되면 새 주문 이벤트를 중복 기록하지 않습니다.

## 내구성과 오류 정책

- 각 이벤트는 동기식 append 후 `fsync`합니다.
- 기존 파일 전체를 시작 시 검사합니다.
- 손상된 JSON, 빈 중간 행, 지원하지 않는 스키마·이벤트, 끊어진 순번을 발견하면 서버 시작을 중단합니다.
- 런타임 기록이 실패하면 킬 스위치를 켜고 자동전략을 끕니다.
- 계좌 초기화는 `ACCOUNT_RESET` 기록이 성공한 뒤에만 실행합니다.
- 손상 파일을 자동 삭제하거나 새 파일로 조용히 대체하지 않습니다.

## 기록하지 않는 정보

다음 정보는 저널에 기록하지 않습니다.

- API Key
- App Secret
- 접근 토큰과 WebSocket 승인키
- 실제 계좌번호
- 환경변수 원문
- HTTP Authorization 헤더

현재 모의주문 이벤트에는 종목, 주문 식별자, 방향, 주문유형, 수량, 가격, 상태, 사유와 체결 상세만 기록합니다.

## 운영 주의사항

저널은 append-only 원본입니다. 사용자가 직접 행을 수정하거나 일부만 삭제하면 다음 시작 시 검증에 실패합니다. 백업·압축·보관주기와 파생 통계 파일은 후속 단계에서 별도로 구현합니다.
