# 2026-09-03 — 검증 불가능한 액션 advisory를 `cairn suite`까지 올림 (#190)

- **브랜치:** `feat/190-suite-unproven-advisory` (develop 기준, PR → develop)
- **배경:** #184가 `Scenario.unprovenAction`(`"DELETE https://…"`)을 advisory로 얼렸지만, 그것이
  보이는 곳은 `cairn discover`의 경고 한 줄과 discover 단계의 `gate: unproven-action` trace 이벤트뿐이었다.
  `cairn suite`는 trace sink를 달지 않고, `suite.ts`의 `freezePayload`는 `truncated`만 싣고 이 플래그는
  싣지 않아서, 사람이 실제로 돌리는 경로(suite)에서는 플래그가 있어도 아무 말이 없었다. 이슈의
  스코프는 딱 두 가지 — freeze payload에 싣기, `SuiteVerdict`와 리포터 라인에 싣기. fail-closed 전환,
  `hashCase`의 `benign` 미해싱, 워터마크 문제는 스코프 밖.
- **구현:**
  - **trace.** `freeze.payload.unprovenAction?: string`을 `truncated` 옆에 추가(`core/trace.ts`).
    `freezePayload`가 `s.unprovenAction`이 있을 때만 싣는다(`truncated`와 같은 spread 패턴).
    `spec/core/trace.md` §Versioning의 "optional payload field 추가 = minor" 규칙과 #160 선례(`attachment`
    필드로 1.0→1.1)를 따라 **헤더를 1.1→1.2로 올렸다**(`TRACE_VERSION`, trace.md 헤더·표·결정 노트).
  - **SuiteVerdict.** `unprovenAction?: string`. `runCase`가 재생한 scenario에서 가져오므로 discover
    직후만이 아니라 **캐시 히트 재생에서도** 나온다 — 플래그가 얼린 skill에 살아 있고, 사람이
    반복해서 돌리는 경로가 바로 그 캐시 재생이기 때문. truncated 분기(아무것도 안 얼림)는 그대로.
  - **표시.** 리포터(`adapters/reporters/suite.ts`)에 `unprovenLabel(v)`를 두고 마크다운 표의 path 셀과
    CLI의 per-case 라인 양쪽이 같은 문구를 쓴다: `· ⚠ unproven action: DELETE https://…`.
    CLI 라인 예: `✓ catalog — discovered + replayed · llm 3 call(s) · ⚠ unproven action: DELETE https://shop/586738`.
    case-end payload에는 넣지 않았다(이슈 스코프 밖, freeze·gate 이벤트로 이미 trace에 남는다).
- **검증:** typecheck·build·**683 테스트**(+2, `test/suite.test.ts`): ① discover → verdict·리포트 라인에
  플래그, 같은 store로 다시 돌린 캐시 재생(LLM 0)에서도 verdict·리포트에 플래그, ② freeze trace
  payload에 `unprovenAction`(`truncated`는 없음). 픽스처는 기존 `StubDriver`를 상속해 클릭 시 numeric
  path의 DELETE를 request 로그에 넣는 `unprovenShop()` 하나. 실앱 도그푸딩은 안 돌림.
- **state 변화:** trace 헤더 `1.2`. #184 후속(a) — #169 벤치에서 플래그 빈도·URL을 셀 때 이제 suite
  trace의 `freeze` 이벤트와 `SuiteVerdict`에서 바로 센다(discover 명령을 따로 돌릴 필요 없음).
  fail-closed 전환(후속 b)은 그대로 미착수.
