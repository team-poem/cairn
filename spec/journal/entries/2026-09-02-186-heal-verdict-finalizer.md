# 2026-09-02 — 이슈 186: 판정 마무리를 함수 하나로, heal 재발견의 truncated를 판정에 반영

- **브랜치:** `fix/186-heal-verdict-finalizer` (develop 기준)
- **문제:** 판정을 조립하는 곳이 둘이었고 규칙은 한쪽에만 걸려 있었다. 일반 재생(`pipeline.ts`)은
  `withStepCompletion`(이슈 90)을 거치지만 outcome-heal(`run.ts`)은 `critic.judge` 결과를 그대로 반환했다.
  heal 경로에서 실제로 새는 건 **재발견이 스텝 캡에 걸려 `truncated`로 끝난 경우**다. 첫 발견이
  truncated면 스위트가 fail-closed로 처리(`suite.ts`, "unverified path, nothing frozen")하는데, 같은
  truncated가 heal 재발견에서 나오면 아무도 읽지 않았다. 부분 상태가 원본 단언을 우연히 만족하면
  초록이고, 그 잘린 경로가 `healedScenario`로 재프리즈돼 다음 실행이 그걸 재생한다.
  이슈 본문의 원래 재현("스텝이 막힘 → heal → 초록")은 heal이 다른 경로로 목표에 도달한 정상 동작이라
  버그가 아니었다. 이 엔트리가 이슈의 실제 대상이다.
- **구현:** `pipeline.ts`에 `finalizeVerdict(judged, incomplete?)` 하나. 재생은 `blockedReason(actions, totalSteps)`
  (이슈 90 규칙)를, heal은 재발견이 `done` 전에 끝났을 때의 사유를 넘긴다. 두 경로가 이 함수만 거치므로 다음 규칙
  (PR 184 플래그의 fail-closed 전환)은 여기 한 곳에 들어간다. 잘린 재발견은 `runScenario`가 `healedScenario`를
  **아예 돌려주지 않고** `truncated: true`를 반환한다 — cli `--freeze`, 스위트, 라이브러리 호출자의
  `if (healedScenario) save(...)`가 전부 같은 규칙을 물려받고, 소비자마다 플래그를 기억할 필요가 없다.
  같은 이유로 **완주했지만 목표에 못 간 재발견도 돌려주지 않는다**(`!judged.passed`) — 일시적 실패로 heal이 한 번
  돌면 멀쩡한 스킬이 LLM이 헤매다 만든 경로로 덮이고 caseHash가 그대로라 재발견도 안 걸리던 자리. 판정 기준은
  `verdict`가 아니라 critic만의 `judged`: "목표에 도달했나"만 보고, 나중에 `finalizeVerdict`에 들어올 규칙
  (이슈 184 게이트)이 목표에 도달한 heal을 붙잡지 않게.
  "목표"는 가드(`no-failed-requests`·`no-console-errors`)를 뺀 단언이다(`goalFailures`) — 재발견 중 일시적 500이
  목표에 도달한 수리를 버리게 하지 않는다. 같은 술어를 트리거에도 건다: 가드만 넘어진 재생은 outcome-heal을 돌리지
  않는다(재발견이 500을 고칠 수는 없고, 매 실행 LLM만 태운다). 막힌 스텝은 여전히 heal한다.
  `RunScenarioOptions.maxSteps`를 heal 재발견에 전달(스위트는 `c.maxSteps`, cli는 `--max-steps`) — 없으면 40스텝
  케이스가 UI 드리프트 후 20에서 잘려 영구 red가 된다. 스위트는 잘린 heal에 `SuiteVerdict.truncated`와 `case-end`
  플래그를 첫 발견과 같은 형태로 싣는다.
- **검증:** typecheck·build·테스트(+9). run: 캡에 걸린 재발견은 단언이 전부 통과해도 빨강이고 `healedScenario`가
  없다; `done`으로 목표에 도달한 재발견은 여전히 초록이고 돌려받는다; `maxSteps: 3`이면 LLM 호출이 기본 20이 아닌
  한 자리에서 끝난다. suite: 잘린 heal은 스토어를 건드리지 않고 `truncated`가 구조화되어 실린다. 테스트 더블은
  클릭에서 던지지 않아 스텝을 "막히게" 할 수 없다 — 원본 실패는 단언으로 만들었다.
- **범위 밖:** pipeline/heal의 다른 재구조화. 한 함수 추가와 가드 한 줄이 전부다.
- **state 변화:** 이슈 186 close. 이슈 184 후속(advisory → fail-closed)은 `finalizeVerdict`에 넣는다.
