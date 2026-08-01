# Realtime UI Interaction Rendering

## 확인된 문제

PulseHFT는 SSE `snapshot` 이벤트를 받을 때마다 `public/app.js`의 `render()`가 `app.innerHTML` 전체를 교체합니다. 시뮬레이션에서는 이 갱신이 약 200ms 간격으로 발생합니다.

텍스트 입력은 기존 코드가 포커스와 선택 영역을 다시 복원할 수 있지만, 운영체제가 표시하는 네이티브 `<select>` 옵션 팝업은 DOM 요소가 교체되는 순간 닫힙니다. 이 때문에 주문 유형의 `지정가 GTC` 옵션을 선택하기 전에 목록이 닫혔습니다.

## 적용한 처리

`public/snapshotInteractionGuard.js`가 애플리케이션보다 먼저 로드되어 다음 구간에서만 SSE `snapshot` 콜백을 보류합니다.

- 주문 유형 `<select>`의 마우스 선택 시작부터 `change`, `focusout`, `pointercancel`까지
- 키보드 선택 시작부터 `change`, `focusout`, `Escape`까지
- 종료 이벤트가 누락되는 경우 최대 15초 안전 타임아웃까지

보류 중 여러 스냅샷이 들어오면 오래된 스냅샷은 버리고 최신 스냅샷 하나만 유지합니다. 선택이 끝나면 최신 스냅샷을 즉시 전달하고 일반 실시간 갱신으로 복귀합니다.

## 변경하지 않은 동작

- 일반 SSE 연결과 오류 처리
- 주문 유형 선택이 끝난 후 `app.js`의 `change` 처리
- 주문 수량과 지정가격 입력
- 시세·호가·체결·계좌 스냅샷 구조
- 서버 주문·체결 엔진

## 자동 검증

`server/test/snapshotInteractionGuard.test.js`에서 다음을 확인합니다.

1. 마우스 선택 중 스냅샷 보류 및 최신 스냅샷만 전달
2. 키보드 `Escape`와 안전 타임아웃에서 보류 해제
3. `snapshot` 이외의 EventSource 이벤트와 속성 전달 유지
