# 2026-08-27 — #172: 단언 grounding이 얼리는 URL을 stable endpoint prefix로 정규화

- **브랜치:** `fix/172-ground-stable-url` (#168 track 3, discover/freeze 신뢰성)
- **문제:** `deriveAssertions`가 매칭에 쓴 제안 문자열을 **그대로** 얼렸다(`grounding.ts`,
  `r.url.includes(a.urlIncludes)` 통과 → `urlIncludes: a.urlIncludes`). 한 런에서 같은 액션 POST가
  두 번 발화하면(항목 2개 담기) 모델이 둘을 풀 URL로 구분하므로 `/cart/add-carts?buyRequestIds=586738`
  같은 일회성 id가 스킬에 박힌다. 어떤 replay도 만족시킬 수 없는 구조적 false FAIL이고,
  outcome-heal도 못 푼다 — `run.ts:229`가 재발견 증거를 **원본** `scenario.assertions`로 판정하고
  `run.ts:242`가 그 단언 그대로 재프리즈하므로, heal은 LLM 비용과 서버 상태 변경만 반복한다.
  스텝 레벨 expect는 `capture.ts`의 `stableEndpointPrefix`로 이미 이걸 피하고 있었고, 단언 경로에만
  정규화가 없었다.
- **구현:** `stableEndpointPrefix`를 export해 grounding이 재사용 — 매칭은 그대로 제안 문자열로 하되,
  **얼리는 값은 매칭된 요청의 stable prefix**(host+path, 첫 동적 세그먼트 앞에서 컷, query/hash 제거).
  일회성 부분만 다른 두 제안은 기존 `dedupeAssertions`가 1개로 접는다. 추가 판단 하나:
  **host만 남으면(첫 경로 세그먼트가 id) freeze 대신 drop** — `urlIncludes: "api.shop.co"`는 그 호스트의
  모든 요청이 만족시키는 false GREEN이라 없는 체크보다 나쁘다. drop 사유는 기존 `onDrop` seam으로
  trace의 gate 이벤트에 실린다.
- **검증:** typecheck·build·467 테스트(+16). 반례 코퍼스는 `test/support/url-corpus.ts`에
  `STABLE_PREFIX_CORPUS` 신설(state.md "휴리스틱 존 변경 시 테이블 주도 반례 동반" 규칙) —
  쿼리/해시 제거, 숫자·uuid·타임스탬프 세그먼트 컷, 안 잘려야 하는 것(`/api/v2/cart`), **알려진 과다 컷**
  (`/api/oauth2-callback` — 8자 이상+숫자 포함이라 id로 오인), 포트 호스트, drop 2케이스를 테이블에 명시.
  회귀 테스트는 두 번 발화 시나리오를 고정(제안 2개 → 단언 1개 → 다음 런의 다른 id도 매칭).
  실앱 도그푸딩은 안 돌림(LLM+브라우저 필요) — 단위·통합 레벨까지만.
- **부작용(기록):** ① 정규화로 짧아진 prefix가 baseline 요청과 새로 겹치면 #137 `markVacuous`가
  이전에는 못 보던 항진을 잡아낸다 — 의도된 방향(가짜 green 노출)이라 테스트로 고정.
  ② 얼린 값에 **host가 포함**되므로 #171(프로즌 시나리오가 절대 URL을 고정해 타 환경 replay를 막음)과
  겹친다. 여기서는 스텝 expect와 동일한 정체성을 쓰는 쪽(파리티)을 택했고, host 제거는 #171이
  두 경로를 한꺼번에 다루는 게 맞다.
- **교차검증(코덱스, PR #178 1차 리뷰) → 컷 규칙 재보정:** 리뷰가 실측으로 blocker 2건을 잡았다.
  ① 기존 컷 조건 "8자 이상이며 숫자 포함"이 실제 라우트 이름을 id로 오인 —
  `/api/checkout-v2/submit` → `shop.co/api`가 되어 무관한 `POST /api/newsletter/subscribe 200`이
  단언을 만족시킨다(false GREEN). 정규화가 판정 경로로 승격되면서 **원래 있던 느슨함이 더 위험한
  자리로 올라온 것** — 스텝 expect는 자기 tail만 보지만 단언은 전체 요청 로그를 뒤진다.
  ② 같은 과다 컷이 #137 baseline과 겹쳐 정상 단언을 전부-항진 fail-closed로 죽이는 false RED도 만든다.
  대응: `isDynamicSegment`를 **id 형상**으로 좁혔다 — 전부 숫자 / uuid / 순수 hex(≥8) /
  "8자 이상 + 숫자 포함 + 하이픈·점·퍼센트 없음". 하이픈·점·퍼센트를 사람이 지은 이름의 표지로 쓴다.
  결과: `checkout-v2`·`b2b-orders`·`oauth2-callback`·`2026-08-27`·`app.3fa4b1c2.js`·percent-encoded는
  살아남고, `ord_8f3a2c`·`orders;id=586738`·`deadbeefcafebabe`는 컷된다.
  **의도적으로 남긴 구멍**(코퍼스에 KNOWN GAP으로 명시): 짧은 id(`a3f9`), 숫자 없는 토큰
  (`ord_abcdef`, base64 슬러그). 판단 기준 = **과소 컷은 시끄럽게 실패(false FAIL), 과다 컷은 조용히
  통과(false GREEN)** 이므로 애매하면 안 자른다.
- **2차 교차검증 → 컷 규칙 3차 보정 + 드랍 파리티:** 리뷰가 새 blocker 3건을 실측으로 잡았다.
  ① 하이픈만 "사람이 지은 이름"의 표지로 쓴 탓에 `checkout_v2`·`v1_orders`·`checkoutV2`·`addToCart2`
  같은 언더스코어·camelCase 라우트가 그대로 과다 컷됐다(1차 blocker가 `-`→`_`로 옮겨간 것뿐).
  ② 접두사 붙은 uuid(`order-<uuid>`)·`sess-a1b2c3d4`·JWT·소수점 타임스탬프는 하이픈·점 때문에
  거꾸로 과소 컷됐다 — 규칙(순수 uuid만 매칭)이 표지 논리에 무력화됐다.
  ③ host-only 드랍이 `deriveAssertions`에만 있고 `freshMutationExpect`에는 없어, 단언에서 false GREEN이라
  버린 값을 스텝 expect가 그대로 얼렸다(문서-코드 불일치).
  대응: 판정을 **세그먼트를 구분자(`-._%;=~`)로 쪼갠 뒤 조각 하나라도 id 형상이면 컷**하는 방식으로 바꿨다.
  이러면 라우트 이름은 조각이 전부 단어라 살아남고(`checkout_v2`·`b2b-orders`·`oauth2-callback`),
  접두사 붙은 id는 조각에 digest가 있어 컷된다. hex 조각은 **숫자를 포함할 때만** id로 본다
  (`decade`·`facade` 같은 단어가 digest로 오인되지 않게). 구분자가 없으면 대문자 유무(camelCase는 이름)와
  숫자 그룹 수(이름은 `base64decode`처럼 한 덩어리, 토큰은 `s3kr3t99`처럼 흩어진다)로 가른다.
  드랍은 `hasStablePath`로 뽑아 양쪽이 같은 판단을 쓰게 했다.
  **날짜 세그먼트는 보존→컷으로 재분류**했다 — `/reports/2026-08-27`의 날짜는 라우트 이름이 아니라
  리소스 키이고, 보존하면 발견 당일만 초록이고 다음 날부터 영구 빨강이 된다(리뷰 실측).
  **KNOWN GAP 문구도 고쳤다**: 과소 컷은 "시끄럽고 싼 실패"가 아니다 — 매치 불가 단언은 실행마다
  outcome-heal을 돌려 LLM을 태운다(run.ts:229). 그래도 false GREEN보다 낫다는 순위는 유지.
- **3차 교차검증 → 숫자 조각 하한 + 날짜 별도 처리 + 회귀 1건:** ① 조각 기반 판정의 "순수 숫자 조각 = id"
  가정이 틀렸다 — 구분된 세그먼트 안의 짧은 숫자는 id가 아니라 **이름 한정사**(`step-2`·`top-100`·
  `tier-1`·`covid-19`·`error-404`·`sale-2024`·`page_2`)다. 리뷰 실측으로 false GREEN 체인이 재현됐다:
  `/checkout/step-2/submit`이 `shop.co/checkout`으로 얼려져 **1단계 제출과 주문 포기(`/checkout/abandon`)
  까지** 그 단언을 만족시킨다. 숫자 조각에 5자리 하한을 뒀다. 하한만 올리면 2차에서 컷으로 재분류한
  날짜가 되살아나므로(`2026`이 4자리) 날짜는 세그먼트 전체 형태(`^\d{4}-\d{2}(-\d{2})?$`)로 따로 잡는다.
  ② HIGH-3 수정이 만든 회귀 — `freshMutationExpect`가 첫 mutation이 host-only면 그대로 포기해서, 루트로
  쏘는 픽셀이 앞에 끼면 그 스텝이 검증을 통째로 잃었다. 조건을 `.find()` 술어에 합쳐 계속 찾게 했다.
  ③ **코퍼스 JWT 케이스가 잘못된 이유로 초록이었다** — 서명을 `abc123`(순수 hex)으로 써서 컷된 것이고,
  실제 JWT 서명은 base64url 혼합 대소문자라 안 잡힌다. 실물 JWT로 바꾸고 KNOWN GAP으로 재분류했다.
- **인정한 한계의 크기 정정:** id 판별이 hex 알파벳만 알고 무구분 세그먼트는 대문자가 있으면 이름으로
  단정하므로, **대문자를 포함하는 id 포맷 전체**(ULID·nanoid·Stripe 키·실물 JWT)가 컷을 빠져나간다.
  "digit-free base64 slug 한 줄"로 적어둔 건 크기가 안 맞아서 코퍼스·소스 주석을 그 크기로 고쳤다.
  컷 확장은 라우트 이름까지 삼킬 위험이 있어 후속으로 뺀다.
- **4차 교차검증 → 날짜 규칙 좁히기 + 코퍼스 정직성:** 새 HIGH는 없었고 MAJOR 3건.
  ① 날짜 정규식 `^\d{4}-\d{2}(-\d{2})?$`가 **부품번호·SKU를 날짜로 인정**했다 —
  `/parts/1234-56/order` → `shop.co/parts`가 되어 `/parts/9999-99/order`가 그 단언을 통과한다(실측).
  세기·월·일 범위를 넣어 `^20\d{2}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$`로 좁혔다.
  ② 인식하는 날짜 형태가 ISO 하나뿐(`08-27-2026`·`2026.08.27`·`2026-W35`·전체 타임스탬프는 미인식)이라는
  사실을 주석·코퍼스에 명시했다. 특히 `2026-08-27T10:00:00Z`는 초 단위라 같은 날에도 재생이 실패한다.
  ③ **코퍼스에 JWT와 같은 유형의 "잘못된 이유로 초록"인 케이스가 3개 더 있었다** —
  `sess-a1b2c3d4`·`ord_8f3a2c`·percent-encoded id. 셋 다 샘플 값이 우연히 순수 hex라 걸린 것이고,
  현실적인 형태(`sess-k9m2p4q7`·`ord_8f3a2k`·짧은 id)는 안 잡힌다. note를 사실대로 고치고 현실 형태를
  KNOWN GAP 케이스로 추가했다. `order-1234` GAP 문구도 "대시로 묶인 숫자 그룹이 모두 5자리 미만인 id"로
  크기를 맞췄다(주문·송장번호가 이 형태).
  ④ `isIdPart`의 `isUuid` 분기는 도달 불가능한 죽은 코드였다(조각은 하이픈 4개짜리 uuid가 될 수 없다) —
  제거하고, 접두사 붙은 uuid가 컷되는 진짜 이유(첫 블록이 digest)를 주석에 적었다.
- **미해결(리뷰 지적, 이 PR 밖):** ① 쿼리로 오퍼레이션을 가르는 API(`/graphql?op=AddToCart`)는 쿼리를
  통째로 버리므로 행위 증명이 사라진다 — 값만 정규화하려면 "실행별로 변하는 값" 판별이 따로 필요하고
  별도 결정 사안. ② host-only drop은 fail-closed가 아니다 — 비항진 `navigated`가 하나라도 남으면
  행위 증명 없이 GREEN이 된다. CLI 경고로 노출하려면 discover→CLI 반환 채널(현재 없음)이 필요.
- **state 변화:** #172 close. #171 착수 시 "단언·스텝 expect 양쪽의 host 고정"을 한 세트로 볼 것.
  후속 후보 2건(위 미해결)은 이슈로 등록 여부 판단 필요.
