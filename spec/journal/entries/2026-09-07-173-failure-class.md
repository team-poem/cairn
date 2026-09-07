# 2026-09-07 — 빨강에 이름 붙이기 (#173)

- **브랜치:** `fix/173-failure-class`.
- **문제:** FAIL 하나가 세 가지 다른 다음 행동(앱 회귀 → 빌드 차단 / 대본 노후 → 재발견 / 환경 불량 → 재시도)을
  뜻하는데 엔진이 구분 신호(blocked 스텝, 요청이 안 떴나 vs 떴는데 비-2xx, 스텝 에러 문구, 가드/목표 분리)를 다
  들고 있으면서 하나도 안 내보냈다. 임베더마다 verdict·트레이스에서 역추론.
- **변경:** `Verdict.failure?: "flow" | "script" | "environment"`(빨강에만). `classifyFailure(verdict, actions)`가
  이미 있는 신호에서 순수하게 유도하고 `finalizeVerdict`가 찍어서 replay·outcome-heal이 같이 물려받음(#186 자리).
  규칙 순서 = blocked 스텝(→ script, 에러가 브라우저/전송을 말하면 environment) → 증명 없는 프리즈(#69·#137 →
  script) → 판정기 고장(LLM 실패·핸들러 없음 → environment) → 목표 실패(→ flow, 단 실패한 목표 전부가 401/403/429로
  거절된 요청이면 environment) → 가드만 실패(→ environment) → 기본 flow. 불확실하면 flow로 기울임(회귀를 "재시도"로
  묻지 않기). CLI 종료코드 0·1(flow)·3(script)·4(environment), 2는 사용법 그대로; suite는 가장 무거운 등급.
  콘솔/suite 리포터가 등급 표시. 두 엔트리에서 `classifyFailure` export.
- **안 한 것:** 5xx를 environment로 볼지(앱 회귀와 인프라 장애를 상태 코드만으로 못 가르므로 flow 유지) ·
  `run-end`에 런 단위 등급(그건 `suiteExitCode`의 몫). `case-end`는 Verdict 객체를 그대로 싣기 때문에 `failure`가
  이미 타고, 헤더 범프 없이 trace.md에 명시.
- **병렬 검증에서 고친 것:** (1) `MCP \S+ failed`가 너무 넓어 "element did not become interactive"·"not clickable"
  (앱/대본 문제)을 environment=재시도로 보냈다 — 전송·네트워크 표식이 있을 때만, 대신 `MCP … timed out`은 environment.
  (2) "가드만 실패 → environment"가 "불확실하면 flow"와 모순: 같은 500이 목표로 보면 flow, 가드로 보면 environment.
  #186의 분리는 재발견이 고칠 수 있느냐의 축이지 누구 탓의 축이 아니다 — 가드만 실패해도 flow, detail에 거절/네트워크
  표식일 때만 environment. (3) suite의 손수 만든 판정(`case crashed`·`discovery truncated`)과 run.ts의 `run crashed`가
  `finalizeVerdict`를 안 타 등급 없음 → Chrome 크래시가 exit 1(회귀)로 나갔다. crashed=environment, truncated=script.
  (4) CLI `main().catch`가 1로 나가 Chrome 미설치가 "회귀"로 읽혔다 → 2(사용법/설정). 인자 누락도 2. (5) actions 없이
  `finalizeVerdict(judged, incomplete)`를 부르면(#195 export 시그니처) `blocked:` detail에서도 script가 안 나왔다 → 폴백.
  (6) 커스텀 스텝 핸들러 없음(script)과 커스텀 단언 핸들러 없음(environment)이 달랐다 → 둘 다 environment.
  (7) suite `onCase` 줄과 `--help`에 등급/종료코드 표시.
- **검증:** 분류 규칙 단위 13 + 종료코드 2 + 실제 재생 경로 3(failOn→script, 초록엔 없음, 딴 페이지→flow) +
  suite 크래시=environment. `npm run test:consumer -- npm`(실제 Chrome) 통과 — `replay:broken`은 flow → exit 1 그대로,
  인자 없는 `cairn replay`는 2. typecheck·build·check:boundaries·전체 테스트.
- **상태 변화:** #173 종결. #197(초록의 강도)은 이 분류의 거울 — 같은 신호, 반대 색.
