# state — 현재 상태 (세션 시작 시 먼저 읽기)

> 작게 유지. 사실·결정·다음 스텝만. 장황한 로그는 `history.md`로.

## 지금 상태
- 단계: **PoC 졸업 ✔ — `poc/harness-v0` → `develop` 머지 완료(`--no-ff`, push됨).** 다음은 v1.
- 핵심 가설 증명됨: discover→freeze→replay 한 바퀴(LLM 발견 → 굳힘 → LLM 없는 결정적 재생 + critic 판정).
- 브랜치 전략: `main → develop → poc/*`. 현재 통합 브랜치 = `develop`. main 보존.
  v1 작업은 `develop`에서 새 `poc/*` 또는 feature 브랜치로.
- 확정: 이름 `cairn`, 모노레포(`packages/harness` + `packages/qa`), TS/Node/ESM, 라이선스 MIT.
- 설계 정본: `docs/design.md` (시각 버전: `docs/design.html`).

## 살아있는 계약/결정
- 아키텍처 불변식 → `spec/architecture.md`.
- 기본 드라이버: Chrome DevTools MCP.
- 형태: **CLI 우선.** 데스크톱 패키징은 확장 선택지.
- 환경별 적용은 커넥터(`ContextProvider`/`Reporter`) 플러그인으로.

## 다음 스텝
1. **(완료 ✔) chrome-devtools-mcp 검증** — 첫 테스트 통과.
   example.com → "Learn more" 클릭 → iana.org 전환, 유발된 네트워크 요청 7개 캡처.
   탐색(navigate)·조작(snapshot→uid→click)·관찰(network) 모두 실재 확인 =
   harness Driver/Evidence 기반 OK.
2. **(완료 ✔) `packages/harness` v0** — 최소 파이프라인 standalone 동작.
   - 단계: Context → Plan → Execute → Judge → Report (결정적, 재생 경로 LLM 없음).
   - 6 인터페이스(`ContextProvider·Planner·Driver·SkillStore·Critic·Reporter`)로만 확장.
   - 구현: InlineContext / StaticPlanner / **ChromeDevToolsDriver(내장 MCP client)** /
     AssertionCritic / Console+JsonReporter / FakeDriver(테스트).
   - 검증: typecheck + vitest 3/3 + **도그푸딩** `cairn run --dogfood` =
     수동 테스트(example.com→Learn more→네트워크 단언)를 코드로 재현, exit 0.
   - 산출 계약: `Result{scenario,context,evidence(3층),verdict}` JSON.

## PoC 종료선 (확정)
- **poc/harness-v0 = discover→freeze→replay 한 바퀴를 통과시키면 끝.** 그 후 develop 졸업.
- 통과 정의: NL 의도 → (LLM) 시나리오 발견 → freeze(파일로 굳힘) →
  **LLM 없이** 결정적 재생, 동일 verdict → (보너스) 주입 버그 critic 검출.
- 그 너머(시각 리플레이·GitHub Action·self-heal·추가 ContextProvider)는 v1 정식 작업.

## PoC 완주 결과 (3) — discover→freeze→replay ✔
- **discover**: `cairn discover "<intent>" --url … [--model] [--freeze f]` —
  observe→act→adapt 루프(불변식 #3). LLM은 `LlmClient` 뒤에 주입(불변식 #5).
  - 기본 백엔드 = **로컬 Claude Code**(`claude -p --model …`, 키 불필요, 기존 인증 재사용).
  - 올바른 기본값 = `ANTHROPIC_API_KEY` → `AnthropicLlmClient`. `createLlmClient` 팩토리가
    env로 선택(키 있으면 Anthropic, 없으면 ClaudeCode) → **교체 용이**.
- **freeze**: 발견된 Scenario → JSON(`FileSkillStore`/`loadSkillFile`).
- **replay**: `cairn replay <skill>` — `StaticPlanner` 결정적 재생, **LLM 0**(불변식 #4).
- **검증(도그푸딩)**: NL 의도 → Claude Code(haiku)가 example.com에서 "Learn more" 클릭 발견 →
  freeze → replay 2회 **동일 출력**(경로 결정성) · pass exit 0 ·
  **주입 회귀(엉뚱한 목적지 단언) → critic 검출 → exit 1**(CI 게이트). 실서버 503도 logic층에서 잡힘.
- 단위테스트 10/10(파서·팩토리·skill 라운드트립·discover 루프 scripted).

## 다음 스텝 (v1)
1. **(완료 ✔)** `poc/harness-v0` → `develop` 졸업 머지.
2. v1: self-heal(깨진 스킬 복구), 입력 ContextProvider(git diff·티켓), 시각 리플레이.
3. 아래 한계 정리(~~Execute settle~~ ✔ / LLM Critic / 파서 테스트 ✔).

## 한계 / 후속(v1)
- **(해결 ✔) Execute 자동대기(settle)** — `Driver.settle()`(네트워크 카운트 안정까지 폴링) 추가,
  파이프라인 Execute에서 observe 전 호출. 기본 idleMs=1000(Chrome이 favicon/font를 지연 로드 → 500은 짧음).
  도그푸딩 7/7 req 캡처(이전 5). MCP 파서 단위테스트 8개 추가. 브랜치 `feat/execute-settle`(develop 머지됨).
  - *잔여*: settle은 휴리스틱 — 지연 리소스가 idleMs 넘게 늦으면 가끔 조기 종료(7 대신 5). SettleOptions로 튜닝.
- **(해결 ✔) LLM Critic** — `LlmCritic`(design §8 v0 "LLM+텍스트 단언"). 자연어 단언 `{kind:"expect",criterion}` 추가.
  LLM은 `expect`가 있을 때만 호출(없으면 LLM 0 → 결정성 유지, 불변식 #4). 기계적 단언은 `checkAssertion` 재사용.
  CLI가 expect 유무로 critic 자동 선택. 증거 3층 요약을 LLM에 제공(design §6). 브랜치 `feat/llm-critic`.
  - 도그푸딩: expect "IANA 문서 도달" → ✓ pass / "쇼핑 카트" → ✗ fail(exit 1). 단위테스트 +3.

## 환경 메모
- harness 내장 Driver는 `npx -y chrome-devtools-mcp@latest --isolated`로 자기 브라우저를 spawn
  (세션 MCP의 기본 프로필과 충돌 방지). Node 25, Chrome 설치 확인.
- 빌드: `npm run build -w @cairn/harness`. CLI: `node packages/harness/dist/cli.js <run|replay|discover>`.
  - `discover "<intent>" --url <u> [--model haiku] [--freeze f]` / `replay <skill.json>` / `run --dogfood`.
- LLM 백엔드: 키 없으면 로컬 `claude -p`(기본), `ANTHROPIC_API_KEY` 있으면 API. `--model`로 모델 지정.

## 규칙 후보 (반복되면 승격)
- 코드 작성 직전 Spec Reference Disclosure 1줄(§3)을 실제로 지킴 — 유지.
- 텍스트 파싱 Driver(MCP 응답)는 brittle → 파서 단위테스트 동반(승격 후보).
