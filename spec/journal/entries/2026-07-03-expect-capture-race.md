# 2026-07-03 — #81: 스텝 expect를 완결된 evidence에서 소급 판정

- **브랜치:** `fix/expect-capture-race` (base: `refactor/discover-structure`)
- **문제:** #72가 재생 레이스는 닫았지만 캡처가 1회 스냅샷 — 제출 요청이 in-flight(status 0)면 expect를 안 붙여 그 스텝이 detect→heal 밖(실앱 도그푸딩서 재현). 1차 시도(스텝마다 바운드 폴링)는 또 하나의 타이밍 휴리스틱 + "in-flight=status 0" 드라이버 계약 가정 + 2초 절벽이라 폐기.
- **해법(소급):** 루프는 스텝마다 **워터마크(url·요청 수)만 기록**, expect 판정은 **freeze 시점에 완결된 evidence로 소급**(`assignStepExpects`). 요청 로그는 append-only·상태 제자리 갱신이라 인덱스 슬라이스가 유효. 뒤 스텝들이 도는 동안 응답이 자연히 resolve되므로 **기다림 자체가 사라짐** — 유일한 바운드 대기는 마지막 관측 1곳(`observeOutcomes`, 마지막 스텝의 pending mutation만). deriveAssertions와 같은 철학(완결 evidence에서 grounding).
- **부수 효과:** 스텝당 settle+observe 1회 제거 → 탐색 소폭 빨라짐.
- **검증:** typecheck·**173 테스트**(+2: in-flight 소급 판정·assignStepExpects 슬라이싱)·build OK.
- **state 변화:** 없음(2.3.0 스코프 내 픽스).
