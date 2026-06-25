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

## 2026-06-22 — v1: LLM Critic
- **목표:** design §8 v0의 "LLM+텍스트 단언" 완성 — 자연어 기대를 증거로 판정.
- **한 일:** 자연어 단언 `{kind:"expect",criterion}` 추가. `LlmCritic`(`feat/llm-critic`):
  `expect`만 LLM 판정, 기계적 단언은 기존 `checkAssertion` 재사용(중복 제거). LLM은 `LlmClient` seam 뒤(불변식 #5).
  증거 3층을 compact 요약해 프롬프트로(design §6). CLI가 scenario에 expect 있으면 LlmCritic 자동 선택.
- **결정:** `expect`가 없으면 LLM 호출 0 → 그런 scenario는 결정적 재생 유지(불변식 #4). expect는 opt-in.
  discover의 기본 산출에는 expect 미포함(재생 결정성 보존). LLM 에러는 해당 단언만 fail(런 전체 X).
- **결과(도그푸딩):** expect "IANA 문서 도달"→✓ / "쇼핑 카트"→✗(exit 1, CI 게이트). 단위테스트 18→**21/21**.
  - 잔여: settle 휴리스틱이 지연 리소스에 가끔 조기 종료(req 7 대신 5). SettleOptions 튜닝 여지.
- **다음:** self-heal(깨진 스킬 LLM 복구) · 입력 ContextProvider(git diff·티켓) · 시각 리플레이.

## 2026-06-22 — v1: self-heal (cairn 루프 완성)
- **목표:** 굳힌 스킬이 깨졌을 때(요소 이름 변경 등) LLM이 복구해 재생 재개 — design §4의 self-heal.
- **한 일:** `SelfHealingDriver`(Driver 데코레이터, `feat/self-heal`): click/type에서 inner가 target 해석 실패 시
  현재 요소 스냅샷 + LLM에게 "원 의도에 맞는 현재 요소" 질의 → 재시도 → `heals[]` 기록. goto/snapshot/settle/observe/close는 위임.
  CLI `replay --heal [--freeze]`: 복구 요약 출력 + 치유된 target으로 scenario 재작성해 재freeze(`applyHeals`).
- **결정:** 안 깨지면 LLM 호출 0 → 건강한 재생은 결정적 유지(불변식 #4, self-heal은 sanctioned 예외).
  maxHeals로 비용 캡. heal 매칭 실패 시 명확한 에러.
- **결과(도그푸딩):** 깨진 스킬("Read more", 실제 링크는 "Learn more") → heal 없으면 ✗(exit 1);
  `--heal`로 Claude Code(haiku)가 "Read more"→"Learn more" 매핑 → ✓ pass(exit 0) + 치유 스킬 재freeze.
  단위테스트 21→**26/26**. **cairn 루프 완성: discover→freeze→replay→self-heal.**
- **이슈:** `navigated` 불리언이 trailing slash(`example.com` vs `example.com/`)를 탐색으로 오판(verdict엔 무영향, follow-up).
- **다음:** 입력 ContextProvider(git diff·티켓) · 시각 리플레이 · navigated URL 정규화.

## 2026-06-22 — 정체성 확정 + README/배너 + 라이브러리 API 1급화
- **정체성(사용자 결정):** cairn = 임베드 가능한 **엔진**(`@cairn/harness`), CLI 제품 아님.
  리드 스토리 = 핵심 루프(discover→freeze→replay→self-heal). 메타포 = 길 표시 돌탑.
  **2-프로젝트 분리:** 프로젝트1(이 레포)=엔진+얇은 CLI, npm 배포 / 프로젝트2(별도, 나중)=이를 install하는 데스크탑 앱.
  → 메모리 `cairn-identity` 저장.
- **README/배너:** 영문 README(메타포→루프→포지셔닝 비교표→quickstart→파이프라인/인터페이스→구조) + `banner.svg`. 리포 public.
- **라이브러리 API 1급화(`feat/library-api`):** `cli.ts`의 조립 로직을 라이브러리로 승격 —
  `runScenario(scenario, opts)`(기본 critic 자동선택·self-heal·드라이버, LLM은 필요할 때만 lazy 생성) +
  `needsLlmCritic` + `applyHeals`를 `src/run.ts`로 추출·export. CLI는 인자파싱·리포터합성·exit코드만 남긴 얇은 소비자.
  → 프로젝트2(데스크탑)가 CLI 복붙 없이 `import { runScenario }`로 사용 가능.
- **결과:** 단위테스트 30→**35/35**, typecheck/build OK. 도그푸딩(run --dogfood, replay --heal) 동작 보존 확인.
- **다음:** npm 배포 준비 → v2(git diff ContextProvider).

## 2026-06-22 — 헥사고날 재구조화 (배포 전 정리)
- **목표:** 코드를 패턴이 드러나게 정리(보기 편하게) — 배포 전.
- **결정:** Ports & Adapters(헥사고날). `core/`(순수 도메인+포트) ↔ `adapters/`(구현) 분리, 의존방향 adapters→core.
  `run.ts`는 기본 어댑터 조립이라 core 아닌 **루트**(core 순수성 유지). 기존 패턴(Decorator=self-heal/Factory=createLlmClient/
  Strategy=포트 교체/Pipeline)이 구조로 명시됨.
- **한 일(`refactor/hexagonal`):** `git mv`로 이동(히스토리 보존) — types/ports(←interfaces)/pipeline/discover→`core/`,
  구현→`adapters/{drivers,critics,reporters,planners,context,skills,llm}`. `llm/client.ts`(LlmClient 포트)를 `core/ports.ts`로 병합.
  import 경로 일괄 갱신. 빌드: 테스트 제외 `tsconfig.build.json`, `build`가 dist clean.
- **결과:** typecheck/35테스트/build OK, 도그푸딩 보존. 공개 API 배럴(`@cairn/harness`) 불변(exports/bin 그대로).
- **다음:** npm 배포 준비(package.json 메타데이터·org) → v2.

## 2026-06-22 — npm 배포(cairn-engine@0.1.0) + discover 복원력
- **배포:** unscoped `cairn-engine`로 npm 게시(`cairn` org 만들기 싫다 하여). 토큰(granular)으로 publish, GitHub v0.1.0 태그.
  `npx`·`import` 양쪽 동작 확인(낯선 사용자 시뮬). 사용은 `import { runScenario }`가 메인, CLI는 보조.
- **실전 도그푸딩(delivered.co.kr Ktown4U 플로우):** discover가 액션 실패 시 **크래시**하던 버그 발견 →
  `fix/discover-adapt`: (1) 실패를 LLM에 피드백해 적응(observe→act→**adapt**, 불변식 #3 완성), (2) 실패 요소 기억해 무한 반복 방지.
  결과: 크래시·무한루프 없이, 막히면 "불가능" 판단 후 종료. 단위테스트 +1(36/36). 버전 0.1.1.
- **남은 갭(실전이 드러냄):** Driver에 **hover 없음** → 호버/flyout 메뉴(예: 내비의 Ktown4U) 못 펼침. 텍스트 클릭만 가능.
  (해당 스토어 URL은 점검/404였음도 확인.) → 다음 후보: Driver hover 액션.
- **다음:** v0.1.1 재배포 여부 · Driver hover · v2(git diff ContextProvider).

## 2026-06-23 — 브라우저 액션 세트 확장 (v0.2.0)
- **목표:** hover만 찔끔이 아니라, 실제 자동화에 필요한 핵심 액션을 한 번에 갖추고 재배포.
- **한 일(`feat/driver-actions`):** Driver 포트 + Step 타입 + discover 어휘 + 파이프라인 동시 확장 —
  **hover**(flyout 메뉴) · **pressKey**(Enter/Escape/Tab) · **select**(드롭다운) · **doubleClick** · **scroll**(지연로딩).
  chrome-devtools-mcp 도구로 매핑(hover/press_key/fill/click+dblClick/evaluate-scroll). FakeDriver 기록, SelfHealingDriver는
  target 기반 액션(click/doubleClick/hover/type/select) 모두 heal, pressKey/scroll은 위임. applyHeals를 모든 target 스텝으로 일반화.
- **결과:** typecheck/37테스트/build OK. 버전 0.2.0.
- **실전 재시도(Ktown4U):** 액션은 다 있으나 LLM이 hover 미선택(클릭 실패→메뉴 연결 못 함, 프롬프트/모델 튜닝 영역).
  + `/store/ktown4u`가 일관되게 점검/404 → 스토어 자체가 다운(=플로우 불가, 능력 문제 아님). 해당 플로우는 보류.
- **다음:** v0.2.0 재배포 · (선택)discover 프롬프트 튜닝으로 hover 유도 · v2(git diff ContextProvider).

## 2026-06-23 — 데스크탑 임베드용 안정화 (v0.3.0)
- **목표:** 데스크탑 앱을 올릴 수 있을 만큼 엔진 안정화. **경계 원칙:** 앱 기능(UI)은 앱에 위임, 엔진엔 엔진 능력+포트만.
- **독립 감사**(subagent)로 P0/P1/P2 도출 후 3라운드:
  - **R1 견고성:** 모든 MCP 호출/connect 타임아웃(멈춤 방지) · 연결사망 감지→재연결 · spawn실패/close 시 서브프로세스 누수 차단 ·
    anthropic fetch 타임아웃+429/5xx 재시도.
  - **R2 데스크탑 포트:** `onStep`(스텝 진행 이벤트) · `Driver.screenshot()`+스텝별 캡처(시각리플레이) · `AbortSignal`(취소).
    runHarness/runScenario/discover에 배선. 라이브 검증(실브라우저 PNG dataURL).
  - **R3 최적화+정확도:** snapshot 캐시(한 스텝 내 중복 take_snapshot 제거) · **parseConsole 실포맷(`msgid=N [type] text`) 수정** —
    기존 정규식이 `[error]` 포맷을 못 잡아 `no-console-errors`가 *항상 통과*(콘솔에러 무검출)하던 버그 → 이제 검출(라이브 확인).
- **결과:** 테스트 40→**43/43**, typecheck/build OK. 버전 **0.3.0**. 공개 API에 signal/onStep/screenshots/Driver.screenshot 추가(앱이 소비).
- **남은 폴리시(0.3.x):** 클릭發 다이얼로그(MCP 한계) · hover 실측 · 전역 LLM 예산 · followNewTab 다중탭.
- **다음:** v0.3.0 배포 → 프로젝트2(데스크탑 앱)는 이 포트로 시작 가능.

## 2026-06-23 — Slack 리포트 대조 → 벤치마크 + 견고화 (v0.3.1·v0.4.0, 미배포 누적)
- **방향:** 다른 세션이 Slack "Agentic Testing" 글로 cairn 평가(구조 A·검증 C). 리포트+원글 종합 →
  "기능 추가"가 아니라 **측정·견고화**로 방향 전환. Slack 명제: *실행환경 안정성이 1순위 레버* · *에이전트는 CI회귀에 쓰지 마라*.
- **벤치마크 하네스(`bench/`):** `benchmark.mjs`(discover 비용·replay flakiness) + `churn.mjs`(UI변경 생존·self-heal 비용).
  - 결과: 실전 다단계(saucedemo 로그인+장바구니·todomvc SPA) **replay 4/4·4/4 결정적, LLM 0, ~4s**.
  - 벤치가 엔진 버그 3개 발견·수정(`0.3.1`): parseDecision 다중객체 크래시 · discover 단언 observe-grounding(SPA navigated 오판) · no-failed-requests favicon 오탐.
- **다중 로케이터 견고화(`0.4.0`):** `Target`에 `role`+`index`(구조 위치) 추가, `Driver.locate()`로 freeze시 enrich,
  `resolveTargetUid`가 이름→role+index 폴백. **churn 측정: rename 생존 0/4→4/4, LLM 2/run→0/run** (self-heal 발동 0).
  → Slack 논리대로 replay가 LLM 없이 UI변경 버팀. self-heal은 예외(재정렬·구조변경)만.
- **한계:** role+index는 재정렬엔 약함 · self-heal은 element변경만(플로우변경은 재discover) · 토큰$ 미측정(턴수만).
- **다음(미배포 누적, 한번에 배포 예정):** self-heal 관측신호 · discover 비용절감 · 의미단언. 배포는 0.4.0으로.

## 2026-06-23 — 전 등급 A 방향 + 확장성 개방 → v1.0.0
- **A 푸시:** self-heal `onHeal` 신호(노후 관리) · navigated 목적지 grounding(판정) · **discover 실$ 측정**($0.4–0.6 1회, replay $0 → 풀에이전트 $15–30/run 대비 ~5000배). 점수: 비용 A · 신뢰성 A− · 검증 B+.
- **production-grade 유연성(사용자 핵심 요구 "우리가 정한 것만 흐르면 안 됨"):**
  - 판정층 개방: `Assertion`에 `{kind:custom,name,params}` + `CustomChecks` 핸들러 레지스트리 → 제품이 성공 정의.
  - 액션 개방: `Step`에 `{kind:custom}` + `CustomAction` 레지스트리(runScenario({actions})) → 제품 고유 인터랙션.
  - 나머지는 이미 포트(Driver·Critic·Reporter·Context·Planner·LlmClient) → 로케이터도 custom Driver로.
- **v1.0.0 결정(사용자):** seam을 *다 연 뒤*(=마지막 breaking) 안정 API에서 1.0.0 끊음. README에 확장 문서화. 테스트 54/54.
- **남은(1.x):** discover 단언 제안 훅 · testid 로케이터(chrome-devtools a11y 제약) · 벤치 플로우 확대.
- **다음:** v1.0.0 npm 배포 + GitHub 릴리스.

## 2026-06-23 — 디스패치를 핸들러 어댑터로 통일 (refactor, 미배포)
- **배경:** 바깥 경계는 포트인데 안쪽 분기는 `switch`였다. Execute의 `switch(step.kind)`가 단계 안에 분기를 박아
  **불변식 #2** 위반. v1.0.0이 custom을 *별개 레지스트리*로 열어 한 관심사에 경로 2개(built-in `switch` + custom 레지스트리).
- **변경:** 포트 2개 추가 — `StepHandler`·`AssertionHandler`(`supports()` + `execute()/judge()`). 파이프라인·critic은
  `find(supports)`로 라우팅만 한다.
  - 액션: `BuiltinStepHandler`(switch 캡슐화, `const _: never = step` 누락검사 유지) + `CustomStepHandler`(레지스트리 흡수)
    → `core/steps.ts`. Driver 포트·Step 타입에만 의존 → **의존방향 #6** 안 깸(core→adapters 역참조 없음).
  - 단언: `MechanicalAssertionHandler`+`CustomAssertionHandler`(assertion.ts) · `ExpectAssertionHandler`(llm.ts).
    두 critic이 핸들러 세트로만 구분 — `LlmCritic = AssertionCritic + ExpectAssertionHandler`(first-match-wins로 expect 가로챔).
- **호환:** 공개 API 비파괴(`runScenario`/`runHarness`/`actions`/`custom`). `runHarness`에 체인 교체용 `opts.stepHandlers`만 추가.
- **결과:** 행동 보존(리팩터). 기존 54 + 신규 10 = **64/64**, typecheck/build green. 도그푸딩(실 브라우저)은 미수행.
- **범위 밖(후속 후보):** 미사용 `SkillStore` 포트 · `discover()`↔`Planner` 관계 · 미소비 `Context.baseUrl` · `Skill`/`Scenario` `name` 중복.
- **다음:** `feat/step-handler-dispatch` → `develop` PR.

## 2026-06-24 — 1.1.0 배포 + git-flow 확정 + 도그푸딩 발견(QA 익스텐션)

- **`cairn-engine@1.1.0` npm 배포.** browser-safe export(`cairn-engine/browser` — 런타임-무관 core만, Node 어댑터·`runScenario` 제외)
  + develop/main 갈라진 두 리팩터 결합(handler-dispatch + intent-grounded `expect`: `Critic.judge(…, ctx?)`로 task intent 주입,
  결정성 유지) + anti-slop AGENTS.md(`#10` close). `release/1.1.0`로 develop→main 결합 머지(68 테스트). 태그 `v1.1.0`.
- **git-flow 확정 + CONTRIBUTING 정비.** 옛 'main→develop→feature' 혼선 정리 → develop=통합, develop→main=릴리스(메인테이너),
  수동 publish(자동배포는 보류). develop을 main에 sync. README v1.1 + browser entry. (브랜치 정리는 룰셋이 원격 삭제 막아 UI에서.)
- **도그푸딩(별도 레포 `delivered-qa-chrome-extension`):** `cairn-engine/browser`를 크롬 익스텐션에 install,
  `ExtensionDriver`(chrome.debugger/CDP)로 delivered staging 결제 퍼널(로그인→장바구니)을 실 사이트에서 replay.
  **PoC 핵심(npm 임베드 + CDP replay + 3층 판정 + 실버그 캡처) 증명.** 동시에 **cairn-side 갭 3건** 표면화 →
  익스텐션 레포 `cairn-feedback.md`(커밋X)에 누적, state.md "다음 작업"에 반영:
  1. **`waitFor` 스텝 부재** — 조건 대기 없음(인증 준비 레이스에 replay 깨짐). 최우선.
  2. **CSS/test-id 로케이터 부재** — 이름 없는 요소(카트 체크박스 `button ""`) 못 짚음.
  3. **settle = "전부 완료" 대기** — 웹소켓(Channel Talk)에 안 끝나 매 동작 타임아웃. activity 기반 헬퍼 필요.
- **의미:** "실제 프로덕트로 돌아갈 엔진" 목표를 실 사이트로 시험 → 비전 절반(replay) 작동, 한계(wait/locator)는 명확.
  남은 절반(discover로 시나리오 자동생성)은 미연결(다음 큰 트랙).
- **다음(내일) — 이번 cairn 수정 목표:** **Closes #17**(settle event-based + 클릭發 다이얼로그 + hover) **+ Closes #14**(freeze 타겟 안정성 점수 + 약한 타겟 경고). `waitFor` 스텝 · CSS/test-id 로케이터는 **새 이슈 없이 같이 개선**(자연스러운 업데이트; CSS는 #14 경고의 강화 수단). #17 settle 불릿 = 도그푸딩 settle 발견과 동일 작업. 상세 = state.md '다음 작업' + 익스텐션 `cairn-feedback.md`. `develop`에서 `feat/*` → PR(`Closes #17`, `#14`).

## 2026-06-24 — #17 + #14 해결 (replay 견고성: waitFor · 타겟 점수 · dialogs/hover)

- **브랜치 `feat/robustness-17-14`**(develop에서). **Closes #17 + Closes #14** + waitFor·CSS 동반 개선.
- **`waitFor` 스텝(신규):** `core/types.ts`에 `{kind:"waitFor", until:{url?|requestStatus?|text?/role?}, timeoutMs?}` + `WaitUntil`. `BuiltinStepHandler`가 `observe`/`snapshot` 폴링으로 조건 충족까지 대기 — **새 Driver 메서드 없이, LLM 0**(불변식 #4). 인증-준비 레이스(로그인 직후 `/me` 404 → 홈 튕김) 같은 비동기 준비를 결정적으로 넘김. 테스트 +3.
- **#14 freeze 점수/경고(신규 `core/freeze.ts`):** 순수 `scoreTarget`(selector=1.0 / role+index=0.7 / text-only=0.3 weak / none=0) + `weakTargets`/`scoreScenario`. CLI `cmdDiscover`가 freeze 시 약한(text-only) 타겟 경고. index·browser export. 테스트 +6. **Closes #14.**
- **#17(드라이버 한계 3종):** ① settle = 이미 activity-정적+`SettleOptions`, + `waitFor`가 event-based 대기 보강. ② dialogs = 클릭發 confirm/alert에 MCP가 "open dialog" 에러 → `chrome.ts` `clickAccepting`이 잡아 `handle_dialog(accept)`. ③ hover = 기존 구현이 실제로 동작. **②③를 세션 chrome-devtools MCP로 직접 검증**(dialog: click→에러→handle→confirm=true / hover: `:hover` flyout 드러남). `isOpenDialog` 테스트 +2. **Closes #17.**
- **CSS 로케이터:** `Target.selector` 타입 이미 존재 + #14 점수가 selector 최고 보상. 실제 resolution은 **CDP-direct 드라이버(익스텐션 `ExtensionDriver`)** 몫 — MCP 텍스트 인터페이스는 CSS→uid 매핑 곤란(레퍼런스 드라이버 미해석).
- **검증:** typecheck·build·**79/79**·browser 번들 node 0. cairn 자체 게이트 통과. *실 사이트(delivered) 검증은 배포 후 익스텐션 도그푸딩 단계.*
- **다음:** PR → develop → main(`Closes #17, #14`) → 1.2.0 배포 → 익스텐션 install + `ExtensionDriver` selector resolution(이름없는 카트 체크박스).
