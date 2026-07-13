# 2026-07-09 — runSuite: 캐시-staleness 해시 (브랜치 `feat/suite-runner`, PR #124 리뷰 대응)

## 무엇을

리뷰어 solp721이 PR #124를 블로킹한 두 가지를 처리.

1. **캐시-staleness 해시 (실제 코드 변경).** `src/suite.ts`에 `hashCase(c)`
   (`intent`/`expect`/`assertions`의 sha256) + suite-local 타입 `FrozenSuiteScenario =
   Scenario & { caseHash: string }` 추가. 코어 `Scenario`/`SkillStore`는 건드리지 않음
   (§2 패턴≠데이터 — plain discover/replay/CLI과 공유).
   `runCase`의 캐시 체크: load 성공 후 `caseHash`가 현재 케이스의 해시와 정확히 일치할
   때만 진짜 캐시 히트. load 실패·`caseHash` 없음·불일치는 전부 기존 discover→병합→freeze
   경로로 (미스와 동일하게) 흘려보냄 — fail-closed(#69/#90 계열): replay는 이번 런에
   새로 discover했거나 해시로 검증된 시나리오에만 돈다. 신규 freeze는 `caseHash: hashCase(c)`를
   같이 심음. 이전 버전이 얼린 (해시 없는) 스킬 파일은 stale로 간주 — 1회 재발견 강제.
2. **heal이 사용자 병합 assertion을 보존하는지 (조사 완료, 테스트만 추가).** `run.ts`의
   두 heal 경로(surgical: `applyHeals`/`applyStepHeals`, outcome: `{ ...repaired,
   assertions: scenario.assertions }`) 모두 원본 `assertions`를 보존함이 이미 확인됨 —
   `test/suite.test.ts:147-181`의 기존 heal 테스트는 `steps`만 봤지 `assertions` 내용은
   본 적이 없었음. 확인용 테스트만 추가(코드 변경 없음) — 통과.

## 검증

- `test/suite.test.ts`: 8개 → 10개 (신규 stale-hash 미스 테스트, heal-assertion 보존 확인
  테스트). 기존 캐시 히트 픽스처 2곳(순수 replay, heal re-freeze)에 `caseHash` 스탬프 추가
  (`withCaseHash` 헬퍼) — 안 하면 Fix 1 이후 rediscovery로 오발화.
- 전체 359/359 · typecheck · build 그린 (root, workspaces 전체).

## 결정

- `caseHash`는 `intent`/`expect`/`assertions`만 해시 — `id`/`url`/`maxSteps`는 discover
  결과나 판정 기준에 영향 없으므로 캐시 무효화 트리거 아님.
- outcome-heal 경로는 `repaired`(새 discover 결과)에서 스프레드하므로 `caseHash`가
  자연히 사라짐 — 다음 런이 "해시 없음=stale"로 1회 재발견. surgical heal은 원본
  scenario를 스프레드하므로 해시가 그대로 유지됨. 의도적 비대칭이라 run.ts는 안 건드림.

## state 변화 (머지 후 develop에 반영할 것)

- 이전 엔트리(`2026-07-07-suite-runner.md`)의 "v2 후보: 기준 해시를 freeze에 심어
  드리프트 감지"가 이번에 구현됨 — v1 결정 항목에서 이관.
