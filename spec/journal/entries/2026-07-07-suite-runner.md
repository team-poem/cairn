# 2026-07-07 — runSuite: 케이스 리스트 배치 검증 (브랜치 `feat/suite-runner`)

## 무엇을

`runSuite(cases, opts)` — 사용자가 리스트업한 QA 케이스(NL intent + **사용자의** 성공 기준)를
배치로 검증하는 조립 계층 진입점(`src/suite.ts`, run.ts 옆). 케이스당:

1. 스킬 캐시(`<skillDir>/<id>.skill.json`) 히트 → 결정적 replay만.
2. 미스 → discover 1회 → **사용자 `expect`/`assertions`를 freeze에 병합**
   (discover의 자체 도출 단언은 "런이 한 일"만 증명 — 사용자의 기대가 테스트의 본체) → freeze.
3. replay는 케이스마다 fresh driver(상태 격리; #98 소유권 — 만든 쪽이 닫음).
4. heal 발생 시 re-freeze → 다음 런은 다시 clean.

fail-closed 스탠스: truncated discovery는 동결·재생 없이 실패 처리(#69/#90 계열),
케이스 크래시는 그 케이스만 실패로 markr고 스위트는 계속, config 오류는 실행 전 즉시 거부.

부속: `renderSuiteReport`(순수 렌더러 — Reporter 포트는 런 단위라 통과 안 함),
CLI `cairn suite <cases.json> [--skills dir] [--base-url u] [--no-heal] [--report] [--json]`.

## 검증

- 유닛 8개(`test/suite.test.ts`): 캐시 히트 llmCalls 0(forbidden LLM로 증명) ·
  사용자 기준 병합 · 1회차 discover→2회차 LLM-free · truncated fail-closed(동결 없음) ·
  heal 후 re-freeze · 케이스 크래시 격리 · config 선검증 · 리포트 렌더.
  전체 310/310 · typecheck · build 그린.
- 도그푸딩(로컬 데모샵 3케이스, haiku):
  - 1회차: 3케이스 discover+freeze+replay 전부 pass, 케이스당 LLM 3콜.
  - 2회차: **3케이스 전부 캐시 replay, 스위트 합계 LLM 0콜** — 케이스 단위 경제성 증명.
  - "About"→"About us" 리네임: substring 타게팅이 그냥 흡수(heal 불필요, LLM 0).
  - "About"→"Our Story" 리네임: about만 self-heal 1회(LLM 1콜) → "Our Story"로 re-freeze,
    다음 런 다시 LLM 0. 나머지 케이스는 계속 LLM 0.

## 결정

- suite는 Node 조립 계층이라 `index.ts`에만 export(browser.ts 제외 — runScenario와 같은 이유).
- 캐시 히트 시 케이스의 expect/assertions 변경은 반영 안 됨(스킬 파일 삭제 = 재발견 신호).
  v2 후보: 기준 해시를 freeze에 심어 드리프트 감지.
- 순차 실행(브라우저 1개씩). 병렬은 후속 옵션.

## state 변화 (머지 후 develop에 반영할 것)

- 배치 검증 진입점 `runSuite` + `cairn suite` 추가 — "케이스 리스트 → 판정 N + 리포트 1".
- 파일명 컨벤션의 `*.skill.json`이 suite의 캐시 단위로 승격(`<skillDir>/<id>.skill.json`).
