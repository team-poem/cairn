# state — 현재 상태 (세션 시작 시 먼저 읽기)

> 작게 유지. 사실·결정·다음 스텝만. 장황한 로그는 `history.md`로.

## 지금 상태
- 단계: **harness v0 동작.** `packages/harness` 최소 파이프라인이 standalone으로 돈다.
- 브랜치 전략: `main → develop → poc/*`. v0 작업은 `poc/harness-v0`에서 진행(메인 보존).
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

## 다음 스텝 (v0 후속 / v1 방향)
1. **LLM Critic** — 인터페이스(`Critic`)로 주입. design §8 v0의 "LLM+텍스트 단언" 완성.
2. **Execute 자동대기(settle)** — 알려진 한계: `observe()`가 in-flight 서브리소스와
   레이스(도그푸딩 5 vs 수동 7 req). design §3 "단계별 auto-wait" 자리.
3. v1: 탐색 루프(LLM) → freeze → 결정적 재생, self-heal.

## 환경 메모
- harness 내장 Driver는 `npx -y chrome-devtools-mcp@latest --isolated`로 자기 브라우저를 spawn
  (세션 MCP의 기본 프로필과 충돌 방지). Node 25, Chrome 설치 확인.
- 빌드: `npm run build -w @cairn/harness` → `node packages/harness/dist/cli.js run ...`.

## 규칙 후보 (반복되면 승격)
- 코드 작성 직전 Spec Reference Disclosure 1줄(§3)을 실제로 지킴 — 유지.
- 텍스트 파싱 Driver(MCP 응답)는 brittle → 파서 단위테스트 동반(승격 후보).
