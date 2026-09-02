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
- **구현:** `pipeline.ts`에 `finalizeVerdict(judged, completion)` 하나. `completion`은
  `{kind:"replay", actions, totalSteps}` 또는 `{kind:"rediscovery", truncated}`. 재생은 기존
  `withStepCompletion`으로, 재발견은 `truncated`면 스위트와 같은 문구로 fail-closed. 두 경로가 이 함수만
  거치므로 다음 규칙(PR 184 플래그의 fail-closed 전환)은 여기 한 곳에 들어간다. `suite.ts`의 heal
  재프리즈에 `!healedScenario.truncated` 가드 한 줄 — 판정만 빨갛고 파일은 얼리면 다음 실행이 잘린
  경로를 재생하므로, 같은 규칙을 프리즈 지점에도 건다.
- **검증:** typecheck·build·테스트 691(+3). run: 캡에 걸린 재발견은 단언이 전부 통과해도 빨강(detail에
  truncated); `done`으로 목표에 도달한 재발견은 여전히 초록(finalizer가 heal을 죽이지 않음). suite:
  truncated heal은 스토어를 건드리지 않는다. 테스트 더블(`FakeDriver`·`StubDriver`)은 클릭에서 던지지
  않아 스텝을 "막히게" 할 수 없다 — 원본 실패는 단언으로 만들었다.
- **범위 밖:** pipeline/heal의 다른 재구조화. 한 함수 추가와 가드 한 줄이 전부다.
- **state 변화:** 이슈 186 close. 이슈 184 후속(advisory → fail-closed)은 `finalizeVerdict`에 넣는다.
