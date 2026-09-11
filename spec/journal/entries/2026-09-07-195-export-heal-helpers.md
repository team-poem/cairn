# 2026-09-07 — heal 판정 헬퍼를 공개 엔트리로 (#195)

- **브랜치:** `fix/195-export-heal-helpers`.
- **문제:** #186이 정한 "언제 재발견이 heal인가"(목표 단언만 셈, 가드 제외, `done` 전 종료는 미검증)가
  `core/pipeline.ts`의 `goalFailures`·`finalizeVerdict`·`blockedReason`에만 있고 두 공개 엔트리 어디에도
  없었다. 자기 재발견을 돌리는 소비자는 재구현하고, 가장 자연스러운 재구현(`verdict.passed ? repaired :
  undefined`)이 #189가 실측으로 기각한 그 술어다.
- **변경:** 셋을 `index.ts`·`browser.ts`에서 `runHarness` 옆에 내보낸다. 순수 함수라 브라우저 엔트리에도 안전.
  `hashCase`는 #196 논의(계약 지문) 전이라 넣지 않았다.
- **검증:** 두 엔트리 각각에서 세 함수의 문서화된 동작을 고정하는 테스트(가드 제외, fail-closed + detail 보존,
  blocked 스텝·잔여 개수). typecheck·build·check:boundaries·전체 테스트 통과.
- **검증 결과 고친 것:** 브라우저 엔트리만으로 소비자 heal을 짜서 내장 `runScenario`와 7케이스(가드만 빨강·
  목표 도달·목표 미달·잘림·cap 3·재발견 중 가드·blocked 스텝) 대조 → 전부 일치. 잘림 신호는 `Scenario.truncated`로
  이미 공개. 다만 `goalFailures` 주석이 "돌려줄지 결정"을 혼자 하는 것처럼 읽혀서(실제는 `!truncated &&`가 절반)
  주석을 고쳤고, `blockedReason` 위 고아 JSDoc 병합, `Scenario.truncated` 주석에 정책 블록 케이스 추가.
- **이슈 후보:** export는 소비자가 *올바르게 재구현*하게 해줄 뿐 *상속*은 아니다. `run.ts`의 여섯 단계(트리거에 blocked
  포함 → #78 워터마크 → 재발견 → 원래 단언으로 판정 → truncated로 finalize → 목표 미달 시 보류 → assertions +
  `unprovenAction` 이어붙임) 중 export로 안 실리는 게 셋(워터마크, blocked 트리거, `unprovenAction` 이어붙임).
  이슈 195가 제시한 두 번째 안(조합 가능한 `outcomeHeal(scenario, replay, driver, { rediscover, critic })`)이
  후속. 엔진이 규칙을 소유하고 소비자는 재발견만 공급.
- **상태 변화:** #195 종결. 2.9.0 슬레이트에서 195·199·200·203·8 완료, 남은 건 204·177(작음) →
  196·197·198(설계).
