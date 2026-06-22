# history — 개발 기록 (append)

> 각 항목: 날짜 · 목표 · 한 일 · 결정 · 결과/이슈 · 다음 계약.
> 길어지면 오래된 항목을 `spec/archive/`로 이관.

---

## 2026-06-22 — 개발 하네스 스캐폴딩
- **목표:** AI 에이전트가 cairn을 일관되게 개발하도록 규칙 체계 구축.
- **한 일:** `AGENTS.md`(라우터) + `CLAUDE.md`(심링크), `spec/{architecture,state,history,design}.md`,
  PreToolUse 라우팅 훅(`.claude/hooks/route.sh` + `.claude/settings.json`).
- **결정:** vibe 하네스를 베이스로 — 라우터·disclosure·history는 채택, 개량으로
  (1) 경로 기반 자동 라우팅 훅 (2) state/history 메모리 분리 (3) verify-before-done
  (4) `architecture.md` 불변식 추가.
- **결과:** 파일 기반 하네스 + 라우팅 훅 구성. 코드 스타일 문서는 코드 생기면 추가 예정.
- **다음:** chrome-devtools-mcp 검증 → `packages/harness` v0.

## 2026-06-22 — 설계 정본(markdown) 추가
- **목표:** 에이전트가 읽기 좋은 설계 정본 확보.
- **한 일:** `docs/design.md`(정본) 추가, `docs/design.html`은 시각 버전으로 유지.
  확장점을 범용 인터페이스(`ContextProvider`/`Reporter`)로 정리.
- **결정:** 형태 = **CLI 우선**, 데스크톱 패키징은 확장 선택지. 라우팅 정본을 `docs/design.md`로.
- **다음:** chrome-devtools-mcp 검증 → `packages/harness` v0.

## 2026-06-22 — chrome-devtools-mcp 검증 + harness v0
- **목표:** MCP가 탐색·조작·관찰을 실제로 수행하는지 확인 → `packages/harness` v0 최소 파이프라인.
- **한 일:**
  - MCP 검증: example.com → "Learn more" 클릭 → iana.org 전환, 유발된 네트워크 요청 7개 캡처.
  - Driver 전략 분석(A 내장 MCP client / B 인터페이스+스텁 / C Claude Code 드라이버):
    B는 A의 부분집합, C는 v0 산출물이 아닌(LLM 루프=탐색) 재연 → **A를 B 순서로** 채택.
  - 모노레포 스캐폴딩(workspaces, TS/ESM, vitest) + `packages/harness`:
    types(Evidence 3층) · 6 인터페이스 · pipeline · InlineContext · StaticPlanner ·
    AssertionCritic · Console/JsonReporter · FakeDriver · **ChromeDevToolsDriver(내장 MCP client)** · CLI.
  - 브랜치: `main → develop → poc/harness-v0`(메인 보존, PoC 격리).
- **결정:**
  - v0 Critic은 결정적 텍스트 단언부터(불변식 #4); LLM Critic은 후속 인터페이스 주입.
  - 내장 Driver는 `--isolated`로 자기 브라우저 spawn(세션 MCP 기본 프로필 충돌 회피).
  - MCP 텍스트 응답을 파싱(snapshot uid / `reqid GET url [200]` / selected url) — 파서는 Driver 내부에 격리.
- **결과:** typecheck OK · vitest 3/3 · **도그푸딩** `cairn run --dogfood` 수동테스트 코드재현 exit 0.
  `Result{...evidence(3층)...}` JSON 산출.
- **이슈/한계:** `observe()`가 in-flight 서브리소스와 레이스(도그푸딩 5 vs 수동 7 req) →
  Execute 단계 auto-wait(settle) 필요(design §3). 파서 brittle → 파서 단위테스트 후속.
- **다음:** (1) LLM Critic 주입 (2) Execute settle (3) v1 탐색→freeze→재생.

## 2026-06-22 — PoC 완주: discover→freeze→replay 한 바퀴
- **목표:** cairn 핵심 가설(LLM이 시나리오 발견 → freeze → LLM 없이 결정적 재생) 한 바퀴 통과 → PoC 졸업.
- **결정(범위):** PoC 종료선 = discover→freeze→replay 통과. C(Claude Code 드라이버)는 v0 산출물 아님,
  플러밍은 이미 증명 → 진짜 베팅(발견+결정적 재생)을 끝까지 통과시키기로.
- **결정(LLM 소스):** 모델 비종속(`LlmClient` 인터페이스). 기본 = 로컬 Claude Code(`claude -p`, 키 불필요,
  Claude Code 사용자 대상), 올바른 기본값 = 사용자 `ANTHROPIC_API_KEY`. `createLlmClient` 팩토리로 env 선택 → 교체 용이.
- **한 일:**
  - `LlmClient` seam + `ClaudeCodeLlmClient`(spawn `claude -p`) + `AnthropicLlmClient`(fetch Messages API) + factory.
  - `FileSkillStore`/`loadSkillFile`(freeze/resolve) + `cairn replay`.
  - `Driver.snapshot()`(라이브 인지) 추가 → `discover()` observe→act→adapt 루프(불변식 #3) → `cairn discover`.
  - CLI를 `run|replay|discover` 디스패치로 재구성.
- **결과(도그푸딩):** Claude Code(haiku)가 example.com에서 "Learn more" 발견 → freeze →
  replay 2회 동일 출력(경로 결정성) · pass exit 0 · **주입 회귀 → critic 검출 → exit 1**(CI 게이트).
  실서버 503도 logic층에서 잡힘(critic 가치 입증). 단위테스트 10/10, typecheck/build OK.
- **이슈/한계:** observe() settle(레이스) 여전; LLM Critic 미구현(결정적 단언만); MCP 텍스트 파서 brittle(파서 테스트로 방어).
- **다음:** `poc/harness-v0` → `develop` 졸업(사용자 확인). v1: self-heal·입력 ContextProvider·시각 리플레이.

## 2026-06-22 — v1: Execute auto-wait(settle) + 파서 테스트
- **목표:** 졸업 후 첫 v1 작업 — 증명된 루프 견고화. 알려진 레이스(observe가 in-flight 서브리소스와 경합) 해결.
- **결정:** PoC 졸업했으므로 이제 **PoC 아님 = v1 정식 개발**. `develop`에서 `feat/execute-settle` 브랜치.
- **한 일:** `Driver.settle(SettleOptions)` 추가(네트워크 요청 카운트가 idleMs 동안 안정 → network-idle 근사,
  timeoutMs 캡, best-effort/never throw). 파이프라인 Execute에서 observe 직전 호출, discover 루프도 snapshot 전 settle.
  MCP 텍스트 파서 5종 단위테스트 8개(parseNetwork/parseElements/parseSelectedUrl/findUidByName/parseConsole).
- **결과:** 도그푸딩 req 5→**7** 캡처(favicon/font 포함). 원인: Chrome이 저우선 리소스를 500ms 넘겨 지연 로드 →
  기본 idleMs=1000으로 상향. 단위테스트 10→**18/18**, typecheck/build OK.
- **다음:** LLM Critic(`LlmClient` seam 재사용).
