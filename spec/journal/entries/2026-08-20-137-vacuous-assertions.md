# 2026-08-20 — #137: 항진 단언 — freeze 스탬프 + 전부-항진 fail-closed

- **브랜치:** `feat/137-vacuous-assertion-guard`
- **문제:** 시작 상태가 이미 만족하는 단언(조용한 페이지의 no-failed-requests, 랜딩 요청이 이미 채운
  request-status, 엔트리 URL이 이미 담는 navigated)은 플로우가 아무것도 안 해도 green — 검증력 0의
  false green. #69(빈 단언)·#90(blocked run)의 fail-closed 계보에 남아 있던 마지막 구멍.
- **구현:** discover가 entry goto 직후 baseline evidence 1회 관측(observe 1회 추가) →
  `markVacuous`(grounding.ts, 코어 술어 재사용)가 baseline이 만족하는 단언에 `AssertionMeta.vacuous`
  스탬프(additive, origin과 동형) → frozen 데이터에 실리므로 replay의 `toVerdict`가 **전부 항진이면
  fail-closed**(#69와 같은 자리, baseline을 몰라도 됨 = 재생 결정성 유지). CLI discover는 proof형
  (navigated/request-status) 항진만 개별 경고, 전부 항진이면 "replay will FAIL closed" 경고.
  가드 2종은 스탬프만(개별 경고 없음 — 플로우가 깨뜨릴 수 있는 체크라 판별력이 0은 아님).
  suite 병합 user 단언은 스탬프 없음 → 게이트가 물 수 없음(드랍·강등 없음, 이슈 문구 그대로).
- **검증:** typecheck·425 테스트(+13: markVacuous 유닛 8, toVerdict 게이트 3, discover 통합 2)·build ·
  **실기 2종** — 실제 discover(example.com)에서 가드=vacuous·navigated(iana)=무스탬프 혼합 확인,
  전부-항진 skill replay가 detail과 함께 exit 1.
- **부산물:** suite 테스트 "crashing case"의 ok 케이스가 정확히 이 가짜 green(캐시 미스 → 무행동
  재발견 → 항진만 freeze → 통과)에 의존하고 있었음 — 게이트가 잡아냈고, 테스트를 진짜 탐색으로 수정.
- **state 변화:** fail-closed 계보 완성(#69·#90·#137) — spec/core/judgment.md에 3번째 규칙 등재.
