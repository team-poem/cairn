# state — 현재 상태 (세션 시작 시 먼저 읽기)

> 작게 유지. 사실·결정·다음 스텝만. 상세 기록은 `entries/`로.
> **갱신은 develop에서만** — 작업 브랜치/PR에서 이 파일을 수정하지 않는다(병합 충돌 방지). 작업의 state 변화는 entry에 적고 머지 후 반영.

## 지금 상태
- 단계: **`cairn-engine` 이중 채널.** `latest = 2.4.0` (안정) · `beta = 2.5.0-beta.0` (실험, explore #102).
  - **2.4.0 (latest, 2026-07-06 배포):** verdict 무결성(#96·#86·#87 expect-URL 3형제 + #90·#78·#97) · 비용 리포팅
    `result.usage`(#100) · 드라이버 수명주기 계약(#98·#88) · discover 지각/게이트(#93·#77·#61·#115·#116) ·
    `Target.nth`(#92) + 잔손질. breaking 0.
  - **2.5.0-beta.0 (beta 채널, 2026-07-08 배포):** freeze-less **explore**(#102, `--tag beta`로만 배포 → latest 불변).
  - **develop = 2.5.0 개발선 (정식 릴리스 보류 — 로컬 검증 중, 미배포).** 현재 develop 누적(전부 2.5.0行, breaking 0):
    explore(#102/#123) · **select a11y-native**(#129/#130 — 커스텀 ARIA 드롭다운 open→pick, 불변식 #7 "동사는 벌어서 얻는다") ·
    **중복이름 addressing**(#127/#128 — 프롬프트 서수·Decision role/nth·정확매치 추측금지) · **suite runner**(#122/#124 + 캐시 해시) ·
    **perception**(#132/#133 — Driver 계약·`perceive` seam·role 없는 클릭 리전 승격). ⚠ beta 채널은 아직 explore만(2.5.0-beta.0);
    나머지는 develop에만. 재배포하려면 `2.5.0-beta.1 --tag beta`, 정식화는 develop→main(그때 latest + `dist-tag rm beta`).
  - 계보: 2.0.0 surgical self-heal(breaking) → 2.1 action-grounding → 2.2.x 멀티 LLM/견고화 → 2.3.0 → 2.4.0 → (2.5.0 진행).
    상세 = history + entries.
- **벤치 실측:** 실전 다단계 replay 4/4 결정적·LLM0 · discover $0.4–0.6 1회(replay $0, ~5000배 저렴) ·
  UI rename 생존 0→4/4(LLM 2→0). 벤치 도구는 `bench/`.
- **유연성(핵심):** custom 단언/액션 + 6포트 → "성공·인터랙션·구동·판정"을 *제품이* 정의(우리가 정한 것만 흐르지 않음).
- 토대: 코어 루프(discover→freeze→replay→self-heal) · 헥사고날(core/adapters).
- **경계 원칙(중요):** 앱 기능(UI/타임라인/Stop)은 데스크탑 앱에 위임, 엔진엔 *포트(발신/캡처/수용) + 엔진 능력*만.
- **배포 방법(재현):** unscoped라 org 불필요. `cd packages/harness && npm publish`. 인증은 granular 토큰
  (`"--//registry.npmjs.org/:_authToken=npm_…"`)이 기본이나 **granular 토큰은 만료됨** — 만료 시 E404(권한 없음을
  404로 반환)가 뜨면 토큰 없이 `npm publish`하면 브라우저 CLI 인증(`npmjs.com/auth/cli/…`)으로 붙는다. 버전 올리고 →
  publish → `git tag vX & push` → GitHub Releases 웹에서 노트.
- **⚠ 이중 채널 규칙(중요, 안전장치):** `latest`=안정선, `beta`=실험선(explore). **prerelease는 반드시 `npm publish --tag beta`**
  — `--tag` 빠뜨리면 npm이 `latest`를 prerelease로 밀어버려 explore가 정식 최신이 됨. `-beta.N` 접미사가 `^2.4.0` 범위를
  이중으로 막지만 `latest` 이름표는 별개라 태그 필수. **안정 패치(2.4.1)는 main에서 hotfix 브랜치**로(develop 안 거침 →
  explore 안 섞임). **`develop → main` 머지는 explore를 latest로 정식화하겠다 결심할 때만** — 그때 `2.5.0`(접미사 제거) ·
  `npm publish`(기본 latest) · 이후 `npm dist-tag rm cairn-engine beta`. 소비자 opt-in = `npm install cairn-engine@beta`.
- **정체성(확정):** cairn = 임베드 엔진(`cairn-engine`), CLI 제품 아님. 프로젝트1=엔진+얇은 CLI(배포됨),
  프로젝트2(별도·나중)=이를 install하는 데스크탑 앱. 상세 → 메모리 `cairn-identity`.
- **알려진 한계(v0.2.x 후속):** 클릭發 다이얼로그(confirm/alert) 완전처리 X(MCP per-click 훅 없음) ·
  hover 실효성 실측 미검증 · settle은 휴리스틱(아주 늦은 단일 요청 놓칠 수 있음).
- 핵심 가설 증명됨: discover→freeze→replay(LLM 발견 → 굳힘 → LLM 없는 결정적 재생 + critic 판정) + self-heal.
- **브랜치 전략(확정): git-flow.** `develop`=통합(여기서 `feat/*` 브랜치 → PR), `develop → main` 머지 = **릴리스(메인테이너만)** → 수동 태그 + `npm publish`. 정본 `CONTRIBUTING.md`. (옛 'main→develop→feature' 표기는 폐기.)
- **cairn-bot 운영:** PR은 issue link가 필수이며, `develop`에 머지된 PR의 `Closes/Fixes/Resolves #N` 이슈는 `cairn-bot`이 자동 close한다. `develop → main` 릴리스 머지는 수동이며 issue close 기준이 아니다.
- **파일명 컨벤션:** cairn 임베드 runner 파일은 `*.agentic.ts`, frozen bare Scenario는 `*.skill.json`으로 문서화한다. 예: `checkout.agentic.ts` + `checkout.skill.json`. → #7
- 확정: 이름 `cairn`, 모노레포(`packages/harness` + `packages/qa`), TS/Node/ESM, 라이선스 MIT.
- 설계 정본: `docs/design.md` (시각 버전: `docs/design.html`).

## 2.3.0 — 완료 (배포됨)

> 스코프였던 #64–#69 전부 PR #70–#75로 develop 머지 → main 머지·태그·npm 배포. 과정·설계 근거는
> history 2026-07-02/03 + entries(`2026-07-03-*`)로 이관. 이 섹션의 옛 계획 상세는 git 이력에 있음.

## 2.4.0 계획 — 이슈 슬레이트 #96–#105 (2026-07-06 등록, 미착수)

> 계기: 외부 관점 평가(Slack agentic-testing·에이전트 비용 구조) + 코어 전소스 재리뷰 + 익스텐션
> next-steps 리포트 교차. 기존 오픈 19건과 겹침 전수 확인 후 신규만 등록. 상세 =
> `entries/2026-07-06-issue-slate-2.4.0.md`.

- **신규 버그(판정 신뢰성):**
  - **#96 🔴** freeze가 쿼리/해시-only 이동에 URL expect 오배정(풀URL로 감지, host+path로 얼림) →
    replay 사전체크가 스텝을 조용히 skip. #86·#87과 "expect URL 가족" — 묶어 처리 권장.
  - **#97 🔴** `parseNetwork`가 `[pending]` 드랍 → 레퍼런스 드라이버에서 #81의 mutation 대기가 dead code.
    영향 = MCP 드라이버 사용자(CLI·신규 임베더); CDP-직결 드라이버는 무관.
  - **#98 🟠** outcome-heal 드라이버 수명주기(close된 드라이버 재사용·재발견 후 누수·`close()` 부분 리셋).
    **⚠ #88과 동반 설계 필수** — #88(재연결 fatal화) 단독 구현 시 outcome-heal이 깨짐. 기존 이월
    `Driver.reset` 포트 아이디어는 여기로 흡수.
- **잔손질:** #99(프롬프트-grounding vocabulary 드리프트 — no-console-errors) · #105(request-status
  단언 method 파리티, #94 잔여 — #94는 2.3.0 `459315c`로 기해소되어 close).
- **방향성(리포트 유래):** #100(LLM usage/비용 리포팅 — 측정은 `LlmClient` seam이 소유, 호스트 클라이언트
  주입 호환) · #101(look-ahead 배치 플래닝 — 익스텐션 수요 확정, 프롬프트 캐싱과 곱 효과) ·
  #102(freeze-less 탐색 모드) · #103(벤치 복잡도축·대수 — replay 반복 $0 이점 활용) ·
  #104(vision — 결정적 스크린샷 diff 게이트 + 발산 시에만 opt-in vision, surgical-heal 패턴 반복).
- **스코프 제안:** 2.4.0(minor, breaking 0) = 신뢰성 버그(#85–#87·#90–#91·#96–#98) + 이월(#76·#78·#79)
  + 잔손질(#95·#99·#105) + 헤드라인 #100. need-to-discussion(#92·#101·#102·#104)은 합의 후 편입,
  #103은 릴리스 무관. 도그푸딩 막히면 #96·#97만 **2.3.1 패치** 선행 옵션.
- **착수 묶음(같은 파일 = 한 브랜치, A·B·C 파일 비겹침 → 병렬 가능):** A=#96·#86·#87(expect URL,
  capture/steps) · B=#97·#85·#91(chrome.ts, +#89 합류 가능) · C=#98·#78·#76(run.ts outcome-heal,
  #88 의미론 동반 결정) · D=#93·#99(discover 프롬프트/grounding, #61은 재트리아지) ·
  E=#90·#105(critic 소품) · F=#2·#13(타입 위생).
- **설계 장치(이번 사이클 완료 조건에 포함 — 꼬리물기 근본 차단):** ① 묶음 A는 **URL 매칭 반례
  코퍼스 테스트**(테이블 주도)와 함께 출고 — #86은 로케일 리스트 정교화(휴리스틱↑)가 아니라
  **주입 seam**(benign 패턴)으로. ② #97은 **실물 픽스처 규칙**과 함께(규칙 후보 승격). ③ 체인 위
  이슈(#96·#86·#87·#97)는 "이전 수정이 왜 못 잡았나"를 커버하는 회귀 테스트 포함 — 단 **#96의
  계보는 #56이 아니라 #81**(assignStepExpects, `8f696bc`)이므로 테스트 위치 주의. ④ 회귀 체인
  분석 중 "#68 불완전 수정" 주장은 오류(PR #70이 critic까지 수정, #94는 2.2.2 버전 랙 제보)로 판명.
- **담당 분배(파일 소유권 기준, 2.3.0 방식 — 총 21건 확정):** 우리(solp721) = **#97·#85·#91·#89(chrome.ts)
  → #98·#78·#76·#88(run.ts+연결 의미론) → #93·#77(discover 실행측) → #100·#13(usage/Result 표면)**
  (+#61 재트리아지). 팀원(amazon7737) = **#96·#86·#87(steps/capture URL 판정) → #99·#79(grounding.ts)
  → #90·#105(critics/pipeline 판정) → #95·#2(소품)** (+#103 여유 시). ⚠ ports.ts는 #100(우리)·#2(팀원)가
  스치므로 머지 순서만 조율. 논의 트랙 #92·#101·#102·#104는 별도 합의, #8 보류.
- **기존 이슈 보강:** #76 코멘트(outcome-heal이 `actions`도 미상속) · #89 코멘트(followNewTab 동사 커버리지).

### 후속(계속 이월)
- **뷰포트/레이아웃 강제 · refine gate** — 익스텐션서 해결됨(드라이버 줌/탐색 전 1콜). 범용화 시 엔진.
- 파라미터 슬롯 · setup chain semantics · `mustProve` seam. (`Driver.reset`은 #98로, look-ahead·vision은 #101·#104로 승격.)

## 이번 작업 — Closes #17 + #14 (브랜치 `feat/robustness-17-14`, 구현·검증 완료)

> 소비자 QA 도그푸딩이 드러낸 한계. 상세 = 익스텐션 `cairn-feedback.md`(커밋X). **1.2.0으로 배포·소비 완료.**

- ✅ **`waitFor` 스텝** — `{kind:"waitFor", until:{url?|requestStatus?|text?/role?}, timeoutMs?}`. `observe`/`snapshot` 폴링, LLM 0(불변식 #4). `core/steps.ts` + 테스트.
- ✅ **#14 freeze 점수+경고** — `scoreTarget`/`weakTargets`/`scoreScenario`(`core/freeze.ts`, 순수). CLI(`cmdDiscover`)가 freeze 시 약한(text-only) 타겟 경고. index·browser export. → **Closes #14**
- ✅ **#17 settle** — 이미 activity-정적 + `SettleOptions` 노출 + 새 `waitFor`가 "event-based 대기" 항목 충족.
- ✅ **#17 dialogs** — 클릭發 confirm/alert: MCP가 "open dialog" 에러 → `chrome.ts` `clickAccepting`이 `handle_dialog(accept)`로 처리. **세션 chrome-devtools MCP로 흐름 직접 검증**(click→에러→handle→confirm=true).
- ✅ **#17 hover** — 기존 구현이 실제로 `:hover` flyout 메뉴를 드러냄. **MCP로 검증**(코드 변경 없음). → **Closes #17**
- **CSS 로케이터(자연스러운 동반):** `Target.selector` 타입 이미 존재 + #14 점수가 selector를 최고로 보상. *실제 resolution은 CDP-direct 드라이버(익스텐션 `ConsumerDriver`) 몫* — MCP 텍스트 인터페이스는 CSS→uid 매핑이 어려움(레퍼런스 드라이버는 selector 미해석).
- 검증: typecheck·build·**79 테스트**(+11)·browser 번들(node 0).

## 이번 작업 — 1.3.0 (브랜치 `feat/discover-judge-heal-15-16`, 구현·검증 완료)

> QA 도그푸딩 PoC(별도 레포 `qa-extension`)가 매핑한 실앱 갭을 엔진에서 해소. `Closes #15, #16` + outcome-aware heal(피드백). 상세·근거 = 익스텐션 `cairn-feedback.md`(커밋X).

- ✅ **#16 grounded 단언 제안** — discover 끝에 LLM이 intent 기반 단언을 제안해 freeze에 박음. 기본은 *mechanical*: 제안된 `request-status`를 **실제 캡처 요청과 대조 검증**해야 보존(환각 드롭) + `navigated{to}`. 약한 기본판정("passed but wrong")을 결정적으로 메움. `expect`(LLM판정)는 `semanticChecks` opt-in — 아니면 AssertionCritic이 FAIL시키므로(invariant #4 재생 결정성 유지). `core/discover.ts`. → **Closes #16**
- ✅ **#15 discover 프롬프트 비용** — `slice(0,60)` → **relevance ranking**(인터랙티브+intent 관련 우선)으로 무거운 페이지서 타겟 누락 방지(비용 아닌 *정확성* 효과). 스텝 간 스냅샷 *unchanged* 시 재전송 생략. system 프롬프트 **caching**(`anthropic.ts` cache_control). `core/discover.ts` + adapter. → **Closes #15**
- ✅ **outcome-aware heal (피드백)** — replay verdict가 FAIL(스텝은 다 돌았는데 결과가 틀림 — locate-heal이 못 잡는 break)이면 시작점부터 **re-discover로 복구**(invariant #4 sanctioned use (b); 성공 replay는 LLM 0 유지). `run.ts`(`runScenario`) + CLI re-freeze. *self-heal이 진짜 도는* 견고 replay 완성.
- 검증: typecheck·build·**83 테스트**(+4)·browser 번들(node 0).

## 다음 스텝
1. **(완료 ✔) 1.3.0 배포** (#15·#16 + outcome-aware heal, npm·익스텐션 소비) · **#5 frozen 포맷 정리(PR #27 머지)** — frozen 파일=bare Scenario. *다음 릴리스 버전/체인지로그에 breaking 표기.*
2. **(✅ perception은 익스텐션서 해결) → cairn 엔진의 진짜 과제 = "수술적 자가치료":**
   - 익스텐션이 *이름없는 요소 합성라벨 노출* + *시작 앵커(goto)* 로 perception·시작-페이지 의존을 풀어 discover·replay 안정화. **그 위에서 cairn 갭이 깨끗이 드러남.**
   - **목표(설계 합의):** "적용된 케이스는 LLM 0 + 필요시에만 자가치료로 LLM" — 결정적 replay와 유연성을 *동시에*. **토대 = freeze가 *스텝별 의도*(목적·기대)를 담아 → replay가 스텝 단위로 어긋남 감지 → *그 스텝만* LLM 적응 → re-freeze 수렴.** 현 self-heal(로케이터만)·outcome-heal(통째 재발견)은 거친 1차 근사 — #14·#6·stateful 적응형 replay가 *이 한 방향으로 수렴*.
   - **설계 정식화 완료 →** [`spec/core/surgical-heal.md`](../core/surgical-heal.md). 1.3.0 코드 직접 진단 + A급 평가로 *뿌리 = 스텝 단위 결과 검증 부재*로 재정의, P1~P10 인벤토리, **키스톤 = `expect`(감지)+`intent`(수정) 쌍**(순서 아님), `skip`은 post-condition 게이트. 흡수: #7(통째→스텝수술)·#6(스텝 expect)·#14 심화.
   - **v1 구현 완료** (`feat/surgical-heal`, **87 테스트·빌드 OK**): `Step += {intent, expect}`(expect=`WaitUntil` 재활용, `conditionMet`으로 결정적 검증) · discover가 intent(=reason)+expect(nav) 캡처 · 파이프라인 per-step 검증(*이미 hold면 결정적 skip*=idempotency, 어긋나면 detect) · `StepHealer` 포트+`LlmStepHealer`(intent 기반 수선) · `applyStepHeals` re-freeze · **P2 false-green 픽스**(outcome-heal이 *원래* 단언으로 판정).
   - **P1~P10 전부 구현 완료** (`feat/surgical-heal`, 93 테스트·build OK): P3 positional 모호-폴백 거부 · P4 discover waitFor 생성 · P5 heal role/index 보존 · P6 perception 정직화 · P7 benign 주입 · P8 한국어 토큰화 · P10 truncation 신호 · P9 identity-keying.
   - **✅ 2.0.0 배포** (develop→main #42, tag v2.0.0, npm, GitHub Release). 익스텐션 재도그푸딩으로 실앱 검증 — 깨끗한 replay LLM 0 확인.
   - **✅ 2.1.0 작업 중** (`feat/action-grounding`): 재도그푸딩이 *false green*을 드러냄(/payment 도착했지만 체크아웃 안 함 → 끝-단언만 보니 PASS). → **action-grounding**(단언을 *행위 POST*에 ground) + **no-failed-requests grounding**(탐색 중 실패 없을 때만 박음) + #28 keywords · #3 Planner doc. 95 테스트·build. breaking 0(minor).
   - **✅ 2.1.0 배포 + 익스텐션 실앱 검증 완료.** action-grounding 동작 확인 — 재탐색 시 단언이 *체크아웃 POST*(`buy-request/validation`, buyRequestIds 담김)·로그인 POST에 ground됨(전엔 `/payment` GET만). 🩹데모가 *진짜 체크아웃*(cartid 있음)하고 통과 — `/payment` 직접 점프는 그 POST가 안 떠서 이제 FAIL = **false-green 구조적 해소.** no-failed-requests grounding도 동작(/me 404 봐서 안 박음). 사람 하드코딩 0.
   - **다음:** 더 깊은 실앱 케이스 누적(상태 divergence·3층 판정). 당장 급한 엔진 갭은 없음.
   - 안전(검토 후보): cairn 차원의 origin 경계/boundary(자동화가 외부 PG로 넘어가는 것 방지) — 익스텐션선 가드 추가됨.

## spec 재구성 (2026-06-26)

- **`spec/core/`** (영문) = 핵심 메커니즘 스펙: `the-loop`·`judgment`·`targeting`·`surgical-heal`. **`spec/journal/`** (한국어) = `state`·`history`. **`spec/README.md`** = 트리 인덱스. `architecture.md`·`docs/design.md` 영문화.
- 역할 분리: **core**=메커니즘(왜/어떻게) · **architecture**=불변식(규칙) · **design**=제품 · **journal**=현재·기록.

## 살아있는 계약/결정
- 아키텍처 불변식 → `spec/architecture.md`.
- **코드 구조: Ports & Adapters(헥사고날).** `src/core/`(도메인+포트: types·ports·pipeline·discover·steps) ↔
  `src/adapters/`(구현). `run.ts`=조립(루트). 의존방향 adapters→core. 공개 API=`src/index.ts` 배럴.
- **Execute/Judge 디스패치:** 종류별 분기는 `StepHandler`/`AssertionHandler` 포트로 라우팅(`supports()→execute()/judge()`).
  built-in `switch`는 `BuiltinStepHandler`에 캡슐화(타입 누락검사 유지), custom 레지스트리는 핸들러로 흡수. 새 액션·단언=핸들러 등록(core 불변).
  기본 핸들러는 `core/steps.ts`(Driver포트·Step타입만 의존 → 의존방향 유지).
- **Frozen skill 포맷:** 파일 자체가 bare `Scenario`다. wrapper `{name, scenario}`와 이중 `name`은 쓰지 않는다.
  `SkillStore.resolve(name)`와 `loadSkillFile(path)`도 `Scenario`를 반환한다.
  저장도 도메인 API로: `saveSkillFile(path, scenario)`(mkdir 재귀 + bare Scenario JSON) — README에서 raw `writeFileSync` 노출 금지.
- 기본 드라이버: Chrome DevTools MCP.
- 형태: **임베드 엔진 + 얇은 CLI.** 데스크탑은 별도 프로젝트(엔진 install).
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
2. v1: ~~self-heal~~ ✔ · ~~LLM Critic~~ ✔ · ~~Execute settle~~ ✔ — **cairn 루프 완성**
   (discover→freeze→replay→self-heal). 남음: 입력 ContextProvider(git diff·티켓), 시각 리플레이.
3. **(해결 ✔)** `navigated` 불리언 trailing-slash 오판 → `normalizeUrl`/`isNavigation`로 정규화 비교.
   브랜치 `fix/navigated-normalize`. 단위테스트 +4(총 30/30).

## 한계 / 후속(v1)
- **(해결 ✔) Execute 자동대기(settle)** — `Driver.settle()`(네트워크 카운트 안정까지 폴링) 추가,
  파이프라인 Execute에서 observe 전 호출. 기본 idleMs=1000(Chrome이 favicon/font를 지연 로드 → 500은 짧음).
  도그푸딩 7/7 req 캡처(이전 5). MCP 파서 단위테스트 8개 추가. 브랜치 `feat/execute-settle`(develop 머지됨).
  - *잔여*: settle은 휴리스틱 — 지연 리소스가 idleMs 넘게 늦으면 가끔 조기 종료(7 대신 5). SettleOptions로 튜닝.
- **(해결 ✔) LLM Critic** — `LlmCritic`(design §8 v0 "LLM+텍스트 단언"). 자연어 단언 `{kind:"expect",criterion}` 추가.
  LLM은 `expect`가 있을 때만 호출(없으면 LLM 0 → 결정성 유지, 불변식 #4). 기계적 단언은 `checkAssertion` 재사용.
  CLI가 expect 유무로 critic 자동 선택. 증거 3층 요약을 LLM에 제공(design §6). 브랜치 `feat/llm-critic`.
  - 도그푸딩: expect "IANA 문서 도달" → ✓ pass / "쇼핑 카트" → ✗ fail(exit 1). 단위테스트 +3.
- **(해결 ✔) self-heal** — `SelfHealingDriver`(Driver 데코레이터). 재생 중 target 해석 실패 시
  LLM이 현재 요소로 매핑→재시도→`heals` 기록(불변식 #4의 sanctioned 예외; 안 깨지면 LLM 0).
  CLI `replay --heal [--freeze f]`로 복구·재freeze. 브랜치 `feat/self-heal`.
  - 도그푸딩: 깨진 스킬("Read more") → heal없으면 ✗(exit 1) / `--heal`로 "Learn more" 매핑 → ✓ + 재freeze. 단위테스트 +5.

## 환경 메모
- harness 내장 Driver는 `npx -y chrome-devtools-mcp@latest --isolated`로 자기 브라우저를 spawn
  (세션 MCP의 기본 프로필과 충돌 방지). Node 25, Chrome 설치 확인.
- 빌드: `npm run build -w cairn-engine`. CLI: `node packages/harness/dist/cli.js <run|replay|discover>`.
  - `discover "<intent>" --url <u> [--model haiku] [--freeze f]` / `replay <skill.json>` / `run --dogfood`.
- LLM 백엔드: 키 없으면 로컬 `claude -p`(기본), `ANTHROPIC_API_KEY` 있으면 API. `--model`로 모델 지정.

## 규칙 후보 (반복되면 승격)
- 코드 작성 직전 Spec Reference Disclosure 1줄(§3)을 실제로 지킴 — 유지.
- **(승격 확정 — #97이 증명)** 코어 로직이 의존하는 드라이버 관측값(예: in-flight status 0)은
  레퍼런스 드라이버 파서 픽스처에 **실물 출력 포맷**으로 존재해야 한다. FakeDriver 주입만으로 green이면 계약 미검증.
- **형질/사실 검문(불변식 #1 운영판):** 앱 통증→엔진 승격 시 "이 수정의 지식은 보편 사실인가,
  이 앱의 형질인가"를 판별 — 형질이면 보편 휴리스틱 금지, seam+주입으로(benign/ActionPolicy 선례).
  근거 = #56 로케일 스트리핑이 #86·#87 회귀를 낳은 교훈.
- 휴리스틱 존(URL 매칭·동적 세그먼트 컷 등)을 변경할 땐 반례 코퍼스(테이블 주도) 테스트 동반 —
  픽스 1개+테스트 1개 방식은 이 지대에서 체인을 못 끊는다.
