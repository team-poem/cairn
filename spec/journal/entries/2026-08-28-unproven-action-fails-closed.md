# 2026-08-28 — 검증 불가능한 액션은 fail-closed (판정 4번째 규칙)

- **브랜치:** `fix/unprovable-action-fails-closed` (`fix/172-ground-stable-url` 위에 스택)
- **문제:** #178이 host-only 값을 얼리길 거부하면서(그 값은 그 호스트의 모든 요청이 만족시키므로
  false GREEN) **드랍이 조용한 통과로 바뀌었다.** 교차검증 실측 예시: 발견 때
  `DELETE https://api.shop.co/586738` 후 `/done`으로 이동한 시나리오는 요청 단언이 드랍되고
  비항진 `navigated`만 남는다. 재생이 DELETE 없이 `/done`에만 도달해도 초록이고, heal도 안 돈다.
  기존 fail-closed 게이트(빈 단언 #69 · 전부-항진 #137)는 **다른 비항진 단언이 하나라도 있으면**
  막지 않으므로 이 구멍을 못 덮는다.
- **구현:** 기존 세 규칙과 같은 구조 — **프로즌 데이터만 읽는다.**
  ① discover가 `hasUnprovenAction`으로 판정해 `Scenario.unprovenAction`을 기록한다(additive).
  조건 둘이 모두 성립해야 한다: 살아남은 비항진 `request-status` 증명이 **없고**, 성공한 비-benign
  mutation 중 **안정 경로가 없는 것**이 관측됐을 때. 증명이 하나라도 얼려졌으면 루트로 쏘는 비콘은
  무관하고, 표현 불가능한 mutation이 없으면 애초에 증명할 액션이 없는 시나리오다.
  ② 파이프라인의 `withProvenAction`이 `withStepCompletion`과 같은 자리에서 verdict에 접는다.
  사용자가 직접 쓴 단언(`origin: "user"`)이 있으면 해제 — #137이 둔 것과 같은 예외다.
- **검증:** typecheck·build·533 테스트(+8). 유닛 5개(증명 있음/항진 증명/체크 가능한 URL/benign 비콘/
  실패한 mutation)와 실행 3개(모든 단언 통과해도 빨강, user 단언이 해제, 플래그 없는 옛 스킬 불변).
  실앱 도그푸딩은 안 돌림.
- **스펙:** `spec/core/judgment.md`의 fail-closed 규칙이 셋 → **넷**이 됐다.
- **state 변화:** #178 본문의 "host-only drop이 fail-closed가 아니다" 한계 해소.
