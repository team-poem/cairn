# 2026-09-08 — #198 지각 정책·관측 참조 테스트 초안

- **브랜치/기준:** `codex/198-perception-contract`, 최신 develop `868412e`에서 분리한 `apps/cairn-198`.
- **대화에서 승인된 범위:** 공통 지각 정규화·랭킹, 60개 제한 뒤 포털 옵션 보존, 관측 참조로 정확한 요소 실행,
  만료 참조 재관측 및 동명 폴백 거부, freeze에는 영속 로케이터만 저장, 기존 Driver 호환.
- **기준선:** 부모 에이전트가 기존 989개 테스트·typecheck 통과 확인.
- **산출물:** clone에서 제외되는 `failed-test.md`에 50개 후보를 개별 probe한 **47 RED** 항목과 **3 GREEN**
  기존 동작을 분리 기록. 모든 RED는 실행된 assertion 실패이며 collection/인프라 오류를 실패 근거로 삼지 않았다.
  새 정규화 export·Chrome ref 부재에서 먼저 실패하는 항목은 문서에 명시했다.
- **계약 제안:** `PageElement` 관측 사실·ref 추가, 공통 normalize/rank 공개, `Decision.ref`, 선택적 locateRef와
  다섯 동사의 ref 인수. Chrome 추가 DOM 사실은 선택적 `snapshot({perception:true})` 경로로 수집해 기존 기본
  snapshot 캐시/옵션 계약을 보존한다. source role과 중복 순번을 보존하고 ref-only 결정은 정책 호출 전에 정규화한다.
- **검토 반영:** stale 실패 후 같은 이름·상태라도 새 ref 프롬프트를 다시 보여주고 성공하는 경로, 정규화 후 원래
  중복 순번, 두 공개 엔트리의 TypeScript 소비자 계약, Chrome opt-in 경로를 두 루프가 실제 요청하는 배선을 추가했다.
- **한계:** Chrome 테스트는 MCP 스텁이다. 실제 포털·폐색·클릭영역 수집, 페이지 전환 만료, DOM 교체 및 nameless
  영속 로케이터는 구현 후 실브라우저 검증이 필요하다. 테스트 초안을 사용자에게 보여주고 승인받기 전 구현하지 않는다.
- **state 변화:** #198은 Phase 0 테스트 초안 검토 대기. 구현·영구 테스트 추가·커밋·푸시·PR 생성은 아직 없음.
  인간 소유 `spec.md`와 develop 전용 `state.md`는 수정하지 않았다. 승인 후 한 항목씩 Red→Green→Refactor를 진행한다.
