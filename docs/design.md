# Cairn — 설계

> 자연어 의도를 브라우저 동작으로 옮기고, 수집한 증거로 결과를 판정하는 QA 에이전트.

하네스는 LLM 자체가 아니라 **그 주변 설계** — 무엇을 컨텍스트로 넣고, 어떻게 실행하고,
무엇으로 판정하고, 언제 사람을 부를지 — 를 가리킨다.

- **형태:** CLI 우선 (npm 패키지 + CLI). 시각적 리플레이는 로컬 UI.
- **비종속:** 특정 LLM·브라우저에 묶이지 않는다. 기본 드라이버는 Chrome DevTools MCP.

> 사람이 보기 좋은 시각 버전: [`docs/design.html`](./design.html). 이 `.md`가 정본이다.

---

## 1. 설계 제약

- **모델·드라이버 비종속** — LLM도 브라우저 드라이버도 인터페이스 뒤에 둔다. 교체 가능.
- **결정적 재생** — 회귀 실행은 LLM 없이 굳힌(freeze) 시나리오를 재생한다.
- **패턴 / 데이터 경계** — 파이프라인·인터페이스는 코어, 도메인·환경 데이터·커넥터는 플러그인.
- **증거 기반 판정** — 화면이 아니라 실행·화면·로직 3층 증거로 판정한다.

실행의 본체는 파이프라인이며, 루프는 *처음 보는 앱을 탐색하는 단계*에서만 쓴다.

---

## 2. 요구 → 구조

QA가 요구하는 것에서 구성요소를 거꾸로 도출한다.

| QA가 필요로 하는 것 | 그래서 필요한 메커니즘 |
|---|---|
| 대상 앱을 전혀 모름 | 컨텍스트 주입(grounding) |
| 의도를 실행 단계로 풀어야 함 | 시나리오 생성(Plan) |
| 사람처럼 조작해야 함 | 드라이버 (브라우저 도구) |
| 처음 보는 앱이라 경로를 미리 못 짬 | 탐색 루프 (보고·행동·적응) — *여기만 루프* |
| 페이지가 늦거나 동적임 | 단계별 적응 재시도 (robustness) |
| 증거로 옳고 그름을 판정 | 증거 수집 + Critic |
| 회귀 때 LLM 비용을 안 내야 함 | 성공 경로 굳히기(freeze) → 재생 |
| 위험한 순간엔 사람 판단 | 체크포인트(사람 게이트) |

대부분은 순서가 정해진 파이프라인이고, 루프는 "처음 보는 앱"에서만 요구된다.

---

## 3. 아키텍처 · 파이프라인

실행의 본체는 다섯 단계 파이프라인이다.

```
Context → Plan → Execute → Judge → Report
```

`Execute` 안에는 페이지가 늦거나 동적일 때 버티는 단계별 재시도가 있다 —
Cypress·Playwright의 auto-wait와 같은 층위다.

---

## 4. 탐색과 재생

파이프라인에서 불확실성이 있는 지점은 하나다 — **처음 보는 앱.**
DOM을 모르면 어디를 클릭할지 미리 짤 수 없다. 그래서 첫 실행은 **탐색**이다:
보고 → 행동하고 → 바뀐 화면을 보고 → 다음을 정한다.

```
탐색(discover):  의도 + 모르는 앱  →  ↻ 관찰·행동·적응  →  경로 발견   (LLM 루프)
                                   ↓ freeze
재생(replay):    굳힌 시나리오     →  그대로 재생                       (LLM·루프 없음, 결정적)
```

재생 경로에는 LLM이 없으므로 회귀 비용과 flaky가 함께 줄어든다.
LLM이 등판하는 건 두 경우뿐 — (a) 새 시나리오 탐색, (b) 깨진 스킬 복구(self-heal).

> 탐색적(exploratory) 모드 — 새 이슈가 안 나올 때까지 반복 — 은 선택적 확장이다.

---

## 5. 확장점

파이프라인 각 단계는 교체 가능한 인터페이스다. 코어는 기본 구현과 프롬프트를 들고,
특정 환경은 인터페이스만 구현해 꽂는다.

```ts
interface ContextProvider { provide(task): Context }      // NL · git diff · 티켓 · 문서RAG
interface Planner         { plan(ctx): Scenario }         // 의도 → 단계
interface Driver          { goto·click·type·observe() }   // 기본 ChromeDevToolsMCP / 교체 Playwright
interface SkillStore      { resolve(name): Skill }        // 재사용 플로우 · freeze / replay
interface Critic          { judge(evidence): Verdict }    // 단언 | baseline | LLM
interface Reporter        { emit(result) }                // console · json · 임의 트래커
```

- **core** = 파이프라인 오케스트레이션, 기본 드라이버, 탐색·시나리오 생성 프롬프트, 3층 증거 스키마, freeze 로직.
- **plugin** = 환경별 `ContextProvider`·`Reporter` 구현.

**경계 = 패턴 vs 데이터.** 코어(파이프라인·인터페이스·프롬프트)는 범용으로 두고,
특정 도메인·환경의 데이터·커넥터는 플러그인으로 분리한다.

---

## 6. 증거와 판정

Critic은 단정하기 전에 관찰 가능한 사실을 세 층위로 받는다.

```ts
Evidence = {
  execution:  { clicked: true, navigated: true, blocked: false },  // 실행층
  perception: { screenshot: "step3.png", layoutShift: 0 },         // 화면층
  logic:      { requests: [{ url: "/api/orders", status: 500 }],   // 로직층
                console:  ["TypeError: orders is null"] }
}
```

**알려진-항목 억제(known-item suppression).** 입력(변경 요약·티켓)에 "이건 의도적으로
미적용"이라 적혀 있으면 Critic이 버그가 아닌 것으로 분류한다. 오탐을 입력 맥락으로 누른다.

---

## 7. 사용 면

같은 런타임의 두 표면 — 헤드리스 CLI와 시각적 리플레이.

**CLI · CI** — 한 줄로 돌리고 구조화된 리포트를 떨군다. CI(예: GitHub Action)에 물려 PR 게이트로.

```
$ npx cairn run "checkout: 담기 → 결제 → 주문확인"
✓ context assembled — 3 docs · 2 skills
✓ scenario planned  — 5 steps
▶ step 5/5 verify order   GET /api/orders  500
✗ 1 issue — order not shown · evidence captured
  report → ./qa-report.json · exit 1
```

**시각적 리플레이** — 같은 실행을 로컬 UI로 따라간다. 단계 타임라인 + 라이브 뷰 + 3층 증거.

**입력 소스 · 확장** — 입력은 모두 `ContextProvider` 한 인터페이스로 들어온다(자연어 · git diff ·
티켓 · 저장된 시나리오). 새 입력원이나 리포트 대상은 인터페이스 두 개만 구현하면 어디든 붙는다.

```ts
class MyContextProvider implements ContextProvider { /* 임의의 소스 → Context */ }
class MyReporter        implements Reporter        { /* 결과 → 임의의 트래커 */ }

createHarness({ context: new MyContextProvider(), reporter: new MyReporter() })
```

> 확장형: 같은 코어를 로컬 **데스크톱 앱**으로 패키징해, 로그인된 브라우저 세션 위에서
> 돌리는 형태도 가능하다.

---

## 8. 로드맵

| 단계 | 내용 |
|---|---|
| **v0** | 최소 파이프라인 — NL 1개 → 드라이버 실행 → 3층 증거 → Critic(LLM+텍스트 단언) → JSON. |
| **v1** | 탐색 + 굳히기 — 탐색 루프 → freeze → 결정적 재생. self-heal 재시도. |
| **v2** | 입력 소스 + 사람 게이트 — git diff·티켓 ContextProvider, 알려진-항목 억제, 시각적 리플레이. |
| **v3** | 생태계 · 확장 — GitHub Action, baseline diff, 커넥터 SDK, 데스크톱 패키징 등. |

모노레포: `packages/harness`(코어) + `packages/qa`(앱). 라이선스 MIT.

코드가 반드시 지킬 불변식은 [`spec/architecture.md`](../spec/architecture.md).
