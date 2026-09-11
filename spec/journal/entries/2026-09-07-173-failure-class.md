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
- **amazon 리뷰(PR #211)에서 고친 것 — 공통 원인은 렌더된 문자열을 자유 텍스트째로 검사한 것:** (1) `transport`·
  `failed to start` 같은 맨 토큰이 요소 못 찾음 문구(`{"text":"Transport options"}`)와 MCP 페이로드(`Payment failed to
  start`)에 걸려 대본 노후를 재시도로 보냈다 → 드라이버 문구는 문장 시작에 앵커, 요소 못 찾음(`no element matching`·
  `N elements named`)은 검사 전에 script 확정, MCP 봉투 안은 `net::ERR_`·`ECONN*`·`transport closed`만. (2) detail
  폴백이 첫 `;`에서 잘려 뒤의 환경 표식을 못 봤다 → 끝까지. (3) 판정기 고장이 `some`이라 LLM 429 하나가 진짜 목표
  실패를 덮어 exit 4 → 판정기 고장은 목표 판단에서 제외하고 그것만 남았을 때 environment. (4) `got 401, 500`을 첫
  상태만 봐서 도착 순서에 따라 등급이 바뀌었다 → 나열 전부가 거절 상태여야 environment. (5) 가드 detail(콘솔 출력·URL)에
  환경 정규식을 돌려 Socket.IO의 `transport error`, `/transport/quote`가 environment → 가드 텍스트는 안 훑고, 실패
  요청 가드는 첫 실패만 적으므로 `1 failed request(s): 4xx`일 때만 environment. (6) heal의 잘린 재발견 detail이
  script 규칙에 없어 suite(script)와 bare run(flow)이 달랐다 → 통일. (7) `run crashed`가 트레이스엔 environment,
  CLI 종료는 2 → `runScenarioCli`가 런 시작 후 크래시를 잡아 4; 런 전 오류(인자·파일)만 2. (8) "environment =
  재시도"에 재시도로 안 고쳐지는 것(미등록 핸들러, 커스텀 스텝 버그 크래시)이 들어갔다 → 정의를 "앱도 대본도 아닌 것:
  실행 기계·호스트 설정·호출자 거절 — 재시도 또는 설정 수정"으로.
- **2차 리뷰에서 고친 것 — 같은 모양이 둘 더 남아 있었다:** (9) 판정기 고장 검사(`judgeFailed`)가 가드 결과에도
  돌아 콘솔 출력 `Widget needs a registered handler`가 environment → 검사를 단언 종류로 묶음(`expect`는 LLM 실패,
  `custom`은 핸들러 없음, 각 critic의 문구 형식에 앵커). (10) 판정기 고장이 가드보다 먼저라 LLM 429 + 진짜 500이
  environment → 앱 자체 실패(목표·가드)를 다 읽은 뒤 전부 판정기 고장일 때만 environment. (11) 상태 목록에 대기 중
  `0`이 끼면(`got 401, 0, 500`) 3자리 정규식이 첫 값에서 멈춤 → 자릿수 무관 전체 파싱, 0은 거절 아님.
- **검증:** 분류 규칙 단위 22 + 종료코드 2 + 실제 재생 경로 3(failOn→script, 초록엔 없음, 딴 페이지→flow) +
  suite 크래시=environment. `npm run test:consumer -- npm`(실제 Chrome) 통과 — `replay:broken`은 flow → exit 1 그대로,
  인자 없는 `cairn replay`는 2. typecheck·build·check:boundaries·전체 테스트.
- **상태 변화:** #173 종결. #197(초록의 강도)은 이 분류의 거울 — 같은 신호, 반대 색.
