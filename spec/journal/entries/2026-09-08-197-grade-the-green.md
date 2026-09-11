# 2026-09-08 — 초록에 등급 붙이기 (#197)

- **브랜치:** `fix/197-grade-the-green`.
- **문제:** 2xx mutation으로 얻은 초록과 "final URL이 맞았다"로 얻은 초록이 같은 `{ passed: true }`. 소비자가 구간별
  뷰를 만들다 어떤 구간엔 말해주는 체크가 하나도 없는 초록을 발견했는데, 엔진이 말해준 게 아니라 출력 모양을 추론해서
  알았다. `unprovenAction`은 같은 통찰이지만 freeze 시점 산출물이라 replay 판정엔 안 닿았다.
- **변경:** `Verdict.proof`(초록에만, #173의 `failure`의 거울). `proofOf(assertions, unprovenAction)`이 freeze가 이미
  찍어둔 메타(`vacuous`·kind·`origin`)에서 순수하게 등급을 매긴다 — `work`(비항진 request-status/custom, `provesAnAction`과
  동일 조건 — GET request-status도 셈, 맹점 공유·문서화) / `judged`(LLM expect만: 측정이 아니라 주장) / `arrival`(목적지만) / `none`(가드뿐·bare navigated·전부 항진). 함께
  `discriminating`·`vacuous`·`work`·`arrival`·`semantic`·`guards`·`user` 개수와 `unprovenAction`. `finalizeVerdict`가
  초록에 도장 → replay·outcome-heal 동일. 콘솔 pass 줄·suite 표 pass 칸·`cairn discover`(프리즈 시점 등급) 표면.
  두 엔트리에서 `proofOf` export. 트레이스는 Verdict 객체째 실리므로 범프 없음(#173 전례, trace.md에 명시).
- **병렬 검증에서 고친 것:** (1) #137이 clean start에서 가드를 항상 `vacuous`로 찍기 때문에(가드만 있는 시나리오를
  fail-closed로 만들려고) 모든 derived 초록의 pass 줄에 "(2 vacuous)"가 찍혔다 — 그런데 가드는 흐름 중 500이면
  실제로 빨개진다. 가드는 종류로 따로 세고(`guards`) vacuous/discriminating에서 뺌. (2) heal 초록이 원래 단언으로
  등급 매겨진다는 문서화된 규칙에 빨간 테스트가 없었다(원래 시나리오 대신 수리본을 넘겨도 전부 통과) → 원래의
  `unprovenAction`이 heal 초록과 `healedScenario`에 실리는 테스트. (3) `semantic`·`user` 필드 삭제 — 읽는 곳이 없고
  `grade === "judged"`가 이미 말함. (4) `provesAnAction`을 `proofOf`로 구현해 #184 게이트와 등급이 갈라질 수 없게.
  (5) `none` 문구 "a broken flow would fail"은 과장 — 가드는 500에 빨개진다; "조용히 아무것도 안 한 흐름이 통과"로.
  (6) `cairn suite` 케이스 줄에 초록 등급(work 외) 표시, 빨강의 `[flow]`와 같은 자리. (7) suite.ts 고아 주석 이동.
  남긴 것: 옛 스킬(도장 없음)은 landing-page GET도 work로 과대 평가 — 프리즈의 말을 그대로 받는 게 유일하게
  일관된 선택, spec에 명시.
- **안 한 것:** `proof.grade`로 fail-closed 게이트 만들기 — advisory. 전부 항진일 때는 #137이 이미 빨강으로 만든다.
  더 엄한 게이트는 소비자가 `proof.grade`를 읽고 정한다.
- **검증:** `proofOf` 등급·개수·항진·origin·unprovenAction 단위 6 + `provesAnAction` 동치 + finalizer 초록/빨강 배타 +
  실제 `runScenario` 2 + 콘솔·suite 리포터. typecheck·build·check:boundaries·전체 테스트.
- **상태 변화:** #197 종결. #196(계약 지문)이 남은 짝 — 초록의 등급이 바뀌면 이력이 왜 바뀌었는지 말해줄 차례.
