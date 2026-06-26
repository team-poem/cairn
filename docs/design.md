# Cairn — 설계

> 하고 싶은 걸 평소 말로 적으면, AI가 브라우저에서 그 경로를 한 번 찾아 저장하고,
> 이후엔 **AI 없이** 똑같이 재생하며 수집한 증거로 합격/불합격을 판정하는 QA 에이전트.

cairn은 AI 자체가 아니라 **그 주위를 감싸는 엔진** — 무엇을 컨텍스트로 넣고, 어떻게
구동하고, 무엇으로 판정하는지 — 이다.

- **정체성:** 임베드 가능한 **엔진**(`cairn-engine`, npm). CLI 제품이 아니다.
  CLI는 얇은 소비자 하나일 뿐이고, 데스크탑 QA 앱은 이를 install하는 별도 프로젝트.
- **비종속:** 특정 LLM·브라우저에 묶이지 않는다. 기본 드라이버는 Chrome DevTools MCP.
- **상태:** `cairn-engine@1.0.0` 출시(npm) · 54 테스트 · MIT.

> 사람이 보기 좋은 시각 버전: [`docs/design.html`](./design.html). 엔진 상세·벤치마크 숫자는
> 별도 「cairn-engine 엔진 문서」. 이 `.md`가 설계 정본이다.

---

## 1. 설계 불변식

엔진이 지키는 — `spec/architecture.md`에 정의되고 PR 훅으로 강제되는 — 다섯 제약.

- **패턴 ≠ 데이터** — `core/`는 특정 앱·환경을 모른다. 환경별 동작은 포트 구현으로만 주입.
- **확장은 포트로만** — 새 동작은 인터페이스로 추가. 단계 안에 분기를 박지 않는다.
- **루프는 탐색에서만** — 관찰·행동·적응 루프는 *처음 보는 앱을 탐색*할 때만.
- **재생은 결정적** — 굳힌(freeze) 시나리오의 재생 경로엔 LLM이 0. 매번 같은 결과.
- **모델·드라이버 비종속** — LLM도 브라우저 드라이버도 인터페이스 뒤. 교체 가능.

실행의 본체는 파이프라인이며, 루프는 "처음 보는 앱"에서만 쓴다.

---

## 2. 요구 → 구조

QA가 실제로 필요로 하는 것에서 부품을 거꾸로 끌어냈다.

| QA가 필요로 하는 것 | 그래서 필요한 부품 |
|---|---|
| 대상 앱을 전혀 모름 | 컨텍스트 주입(의도를 실제 화면에 맞춤) |
| 의도를 실행 단계로 풀어야 함 | 시나리오 생성(Plan) |
| 사람처럼 눌러야 함 | 드라이버 (브라우저 도구) |
| 처음 보는 앱이라 경로를 미리 못 짬 | 탐색 루프 (보고·누르고·다시 보고) — *여기만 루프* |
| 페이지가 늦거나 동적임 | 로딩 끝까지 기다리는 자동 대기(settle) |
| 증거로 옳고 그름을 판정 | 증거 수집 + Critic |
| 반복 실행 땐 AI 비용을 안 내야 함 | 성공 경로 저장(freeze) → 재생 |
| 성공 기준이 제품마다 다름 | 제품이 정의하는 custom 단언 |

대부분은 순서가 정해진 파이프라인이고, 루프는 "처음 보는 앱"에서만 요구된다.

---

## 3. 아키텍처 · 파이프라인

실행의 본체는 다섯 단계 파이프라인. 헥사고날 — `core/`(도메인+포트) ↔ `adapters/`(구현).

```
Context → Plan → Execute → Judge → Report
```

`Execute` 안에는 페이지 로딩이 끝날 때까지(네트워크가 조용해질 때까지) 기다리는
자동 대기가 있다 — 늦게 뜨는 화면 때문에 잘못 실패하지 않도록.

---

## 4. 핵심 베팅 — 탐색과 재생

불확실한 지점은 하나뿐 — **처음 보는 앱.** 화면을 모르면 어디를 누를지 미리 짤 수 없다.
그래서 첫 실행은 **탐색**이다: 보고 → 누르고 → 바뀐 화면을 보고 → 다음을 정한다.

```
탐색(discover):  의도 + 모르는 앱  →  ↻ 보고·누르고·다시 보고  →  경로 발견   (AI 루프, ~$0.5 1회)
                                      ↓ freeze (JSON 저장)
재생(replay):    저장한 시나리오    →  그대로 다시 실행                          (AI 없음 · 결정적 · ~4s · $0)
self-heal:       UI 변경으로 깨지면  →  AI가 고치고 onHeal로 "노후" 알림         (예외, 깨질 때만)
```

AI의 유연함은 얻되, 매 실행마다 드는 AI의 비용·불안정함(flaky)은 버린다.
AI가 다시 나서는 건 둘뿐 — (a) 새 경로 탐색, (b) 깨진 경로 복구(self-heal).

> 실측: 실전 다단계 플로우 replay **4/4 결정적·AI 0·~4s** · discover **$0.4–0.6 1회**
> (풀 에이전트 $15–30/run 대비) · UI rename **생존 0→4/4**(self-heal AI 2→0).

---

## 5. 확장점 — 제품이 정의한다

파이프라인 각 단계는 교체 가능한 포트다. 코어는 기본 구현·프롬프트를 들고, 특정 환경은
포트만 구현해 꽂는다.

```ts
interface ContextProvider { provide(task): Context }   // NL · git diff · 티켓 · RAG
interface Planner         { plan(ctx): Scenario }      // 의도 → 단계
interface Driver          { goto·click·type·locate·observe·close() } // 기본 ChromeDevTools MCP / 교체 Playwright
interface SkillStore      { resolve(name): Scenario }  // freeze / replay 보관
interface Critic          { judge(evidence, asserts) } // 기계적 | LLM | 제품 정의
interface Reporter        { emit(result) }             // console · json · 임의 트래커
interface LlmClient       { complete(prompt) }         // Claude Code · Anthropic · BYO
```

닫힌 데이터마저 열려있다 — 제품이 **성공 기준**과 **인터랙션**을 직접 정의한다:

```ts
await runScenario(scenario, {
  custom:  { "cart-has": (p, ev) => ev.logic.requests.some(r => r.url.includes(p.path) && r.status === 200) },
  actions: { "drag-slider": async (driver, p) => { /* 제품 고유 인터랙션 */ } },
})
```

**경계 = 패턴 vs 데이터.** 우리는 루프·포트·좋은 기본값(패턴), 제품은 specifics(액션·단언·
로케이터·컨텍스트·시나리오 자산). 오픈소스로 나가는 건 엔진, 도메인 자산은 제품에 남는다.

---

## 6. 증거와 판정

Critic은 단정하기 전에 관찰 가능한 사실을 세 층위로 받는다.

```ts
Evidence = {
  execution:  { actions, navigated: true, finalUrl, blocked: false },  // 실행층
  perception: { screenshot: "data:image/png;…" },                     // 화면층(스텝별)
  logic:      { requests: [{ url: "/api/orders", status: 500 }],       // 로직층
                console:  [{ type: "error", text: "orders is null" }] }
}
```

단언은 **AI 추측이 아니라 실제 일어난 일에 맞춘다** — 정말 navigate 했으면 올바른
목적지(host+path)까지 확인, 항상 실패 요청 없음(favicon 같은 무해한 건 제외).
"성공이 뭔지"는 제품이 `custom` 단언으로, 애매한 목표는 `expect`(AI 판정, 선택)로.

> 다음 단계(미구현): **알려진-항목 억제** — 입력(변경 요약·티켓)에 "이건 의도적 미적용"이라
> 적히면 버그가 아닌 것으로 거른다. AI QA 고질병인 오탐을 입력 맥락으로 누른다.

---

## 7. 제품 형태

하나의 엔진, 세 입구.

**① 임베드(권장) + CLI · CI — 지금.** 엔진을 `import`하거나 CLI로. 재생은 AI도 키도 불필요.

```
$ cairn discover "로그인하고 첫 상품을 담아 카트를 연다" --url shop.example --freeze cart.json
→ 6 steps · frozen → cart.json
$ cairn replay cart.json            # 결정적, AI 0
✓ navigated → /cart.html  ✓ no-failed-requests  ✓ pass · exit 0
```

**② 데스크탑 QA 앱 — 다음(프로젝트 2).** 엔진이 표시 seam을 이미 노출한다 —
`onStep`(타임라인)·`screenshots`(스텝별 PNG)·`signal`(Stop)·`onHeal`(노후 알림).
그 위 **UI는 엔진에 넣지 않고** 별도 앱이 `cairn-engine`을 install해 그린다 —
로그인된 브라우저 세션 위, 비개발자도 보는 시각 리플레이.

```ts
class MyContextProvider implements ContextProvider { /* git diff·티켓 → Context */ }
class MyReporter        implements Reporter        { /* 결과 → 임의의 트래커 */ }

await runScenario(scenario, { context: new MyContextProvider(), reporter: new MyReporter() })
```

---

## 8. 어디까지 왔고, 어디로

| 단계 | 내용 |
|---|---|
| **✓ 엔진 v1.0** | discover→freeze→replay→self-heal · 7포트 + custom 확장 · 3층 증거 · 다중 로케이터 · 데스크탑 seam · 벤치 검증 · npm 배포. |
| **다음 · 제품** | 데스크탑 QA 앱(시나리오 관리·시각 리플레이·스위트·히스토리) — 엔진 위에 얹는다. |
| **다음 · 입력/CI** | git diff·티켓 ContextProvider, GitHub Action PR 게이트, 알려진-항목 억제. |
| **1.x · 엔진 강화** | LLM 백엔드 확대(OpenAI 등) · testid 로케이터 · 의미 단언 결정적화 · 벤치 확대. |

QA툴은 대부분 **엔진 위**(관리·오케스트레이션·히스토리)에 얹는 작업이지 엔진 수정이 아니다 —
엔진/앱 경계가 그렇게 잡혀 있다.

모노레포: `packages/harness`(엔진 = `cairn-engine`) + `packages/qa`(예정). 라이선스 MIT.
코드가 반드시 지킬 불변식은 [`spec/architecture.md`](../spec/architecture.md).
