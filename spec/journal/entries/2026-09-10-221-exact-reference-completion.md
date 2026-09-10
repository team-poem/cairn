# 2026-09-10 — PR #221 exact-ref 회귀 마무리

- **브랜치:** `codex/198-perception-design`. 앞선 `2026-09-10-221-review-regressions.md`의 9/10 상태를 이어서 완료했다.
- **사용자 승인:** `chromeObservationExactNode`의 스냅샷 호출 횟수 기대를 1→2로 바꾸는 한 줄만 기존 테스트 수정 금지의 예외로 허용했다. Target 값·실제 클릭 UID 등 나머지 기존 검증은 유지했다.
- **수정:** `locateRef`가 compact 스냅샷을 새로 읽고 선택한 UID의 이름·역할이 그대로인지 확인한 뒤 그 목록의 index/nth를 저장한다. 완성한 Target이 같은 UID로 해석되는지도 검사한다. 캡처 뒤 관측 연속성을 다시 확인하며, 실패하면 참조를 무효화한다. `2158426`.
- **독립 리뷰 후 보완:** 마지막 비동기 참조 검증과 locator 반환 사이에 다른 탐색이 시작되면 오래된 캐시를 다시 게시할 수 있었다. 공개 `goto()`를 해당 microtask 사이에 시작하는 로컬 재현으로 실패를 확인하고, 반환 직전 참조 객체가 동일한지 동기적으로 검사하도록 수정했다. 같은 재현 통과, 후속 읽기 전용 리뷰에서 지적 해소 확인. `617fbed`. 재현 파일은 `/tmp/cairn221-ref-publication-race.mjs`이며 승인된 테스트 원문은 바꾸지 않았다.
- **검증:** 승인된 마지막 테스트를 원문 그대로 추가해 실패를 확인한 후 수정했다. 계획 10/10 완료. 최종 엔진 1,108개 + portability 5개, 타입 검사·빌드·의존 경계 검사 통과. 기존 실제 Chrome 스위트 17개 통과.
- **실제 MCP 확인:** Chrome DevTools MCP 1.3.0과 격리한 headless Chrome에서 두 캡처 간 exact UID 유지, 새 Driver의 JSON 저장 대상 재생, compact에서 누락된 ref 거부, 캡처 중 DOM 변화 거부, 캡처 실패 후 ref 무효화를 확인했다. 실제 LLM 호출 없음. 로그 `/tmp/cairn221-ref-smoke.log`.
- **테스트 보존 확인:** `/tmp/cairn221-approved-test-audit.py`로 승인된 10개 테스트와 헤더의 원문 일치, 기존 테스트에서 승인한 한 줄 외 변경 없음을 검사했다. 원래 하네스 게이트는 사용자 예외를 표현할 수 없으므로 이 한 줄을 제거된 테스트 행으로 보고한다. 하네스는 수정하지 않으며, 예외를 정확히 제한하는 별도 검사와 전체 스위트 결과를 함께 사용한다.

## 명시적인 한계와 남은 리뷰

compact에 없는 full-tree 후보의 ref는 영구 locator로 저장하지 않고 거부한다. 기존 verbose 순번을 재사용하면 동명 compact 후보를 잘못 클릭할 수 있기 때문이다. 이런 후보를 exact-ref로 저장하려면 별도의 안전한 영구 locator 전략이 필요하다. 기존 frozen option의 compact miss→full-tree 재생은 유지한다.

리뷰 항목 3–7·9, `run.ts`의 policy/perceive/secrets 전달 범위, #225/#226 통합은 이번 수정 범위 밖이다. 일반 `resolveUid`의 verbose 재시도 경로도 그대로 남아 있다. PR 전체 리뷰가 해결됐거나 머지 준비가 끝났다고 주장하지 않는다.

- **state 변화:** 이번에 승인한 리뷰 항목 1·2·8의 회귀 계획은 10/10 완료. `state.md`는 수정하지 않았다. PR 머지·패키지 릴리스는 수행하지 않는다.

## Reflect

- **Brain:** 변경 없음. 루트 하네스 쓰기 제한을 준수했다.
- **Skills:** 변경 없음.
- **Structural:** 변경 없음. 사용자 승인 예외는 정확한 파일·한 줄 비교로 검증했다.
- **Todos:** 루트 추가 없음. 남은 리뷰 범위는 위 기록에 남겼다.
