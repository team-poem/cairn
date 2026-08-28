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
- **5차 교차검증 → 이 작업의 실제 사정거리 정정(중요):** URL을 얼리는 경로는 **넷**인데 이 브랜치가
  정규화한 건 **둘**뿐이다. `request-status`와 `freshMutationExpect`는 고쳤고,
  **`navigated` 단언과 스텝 URL expect(`assignStepExpects`)는 손도 안 댔다** — 둘 다 `destinationKey`만
  거치므로 쿼리·해시만 떨어지고 동적 경로 세그먼트는 그대로 박제된다. 실측:
  `finalUrl = https://shop.co/orders/586738/done` → `to: "shop.co/orders/586738/done"`이 얼려지고
  다음 실행의 `/orders/999001/done`은 `urlReached` false = #172와 같은 영구 false FAIL.
  **`navigated`는 모델 제안 없이 기본으로 붙는 단언**이라 실제 빈도는 `request-status`보다 높고,
  주문번호를 URL에 담는 주문완료 페이지는 커머스 기본형이라 #172 신고 플로우에서 거의 확실히 밟는다.
  단순 치환으로는 못 고친다 — 직접 확인했다: 잘라낸 prefix(`shop.co/orders`)는 `urlReached`가
  "부모 경로는 자식 URL의 도달점이 아니다"로 판정해 **발견 당시의 URL조차 만족시키지 못한다**.
  이동 판정(#96)이 같은 `destinationKey`를 쓰는 것과 얽혀 있어 별도 작업이다 → 후속으로 분리.
- **5차에서 같이 닫은 것 2건:** ① `deriveAssertions`가 status 하한이 없어 **비행 중(status 0) 요청을
  단언으로 얼 수 있었다** — 재생 때 "요청이 떴다"만 확인하고 그 요청이 500으로 끝나도 초록이다.
  스텝 expect는 원래 2xx/3xx를 요구했으니 또 하나의 두 경로 비대칭이었다. 200 하한을 넣고 drop 사유를
  trace에 남긴다. 프롬프트의 "이 중에서 골라라" 목록(`renderEvidence`)에서도 status 0을 뺐다.
  ② dedupe 주석이 코드보다 더 주장하고 있었다 — 정규화는 "한 액션의 두 발화"만 합치는 게 아니라
  **id가 동사 앞에 오면 서로 다른 액션도 합친다**(`/orders/111/confirm` + `/orders/222/cancel` →
  `host/api/orders` 하나). 주문 확정 시나리오가 취소로 통과한다는 뜻이라 주석을 사실대로 고치고
  반례 테스트로 고정했다.
- **6차 교차검증(codex 파일 단위 분할 성공) → 부모에서 HIGH 1 + MAJOR 2:**
  ① **HIGH — 컷이 id 뒤의 액션 동사까지 버린다.** `/api/orders/111/confirm`과 `/api/orders/222/cancel`이
  둘 다 `shop.co/api/orders`로 얼려져 **주문 확정 시나리오가 주문 취소로 초록이 된다.** REST 표준형
  `/collection/{id}/verb` 전부가 해당된다(publish/unpublish, approve/reject…). 다섯 라운드 동안 dedupe
  쪽 절반(제안 둘이 합쳐지는 것)만 봤고, 단언이 하나일 때도 같은 손실이 일어난다는 걸 양쪽 다 못 봤다.
  substring 표현형으로는 "이 접두사 **그리고** 저 접미사"를 표현할 수 없어 구조화 매칭 결정의 입력이다 —
  코퍼스에 `VERB LOST:` 반례 2건으로 박아뒀다. 코퍼스의 `WEAK:`(1세그먼트 prefix)와는 **다른 문제**다.
  ② **MAJOR — grounding이 제안의 method를 무시했다.** `GET /api/jobs 200`이 "POST로 증명하라"는 제안을
  grounded 처리했고, #105가 매칭이 mutation일 때만 method를 얼리므로 **읽기면 만족하는 약한 체크**가 남았다.
  게다가 그 체크가 비항진 `request-status`로 카운트되어 #184 게이트를 꺼버린다. 매칭을 `findRequestStatus`
  (critic이 판정에 쓰는 그 술어)로 교체해 프리즈와 판정이 한 질문을 하게 했다.
  ③ **MAJOR — `YYYY-MM` 단독을 컷 대상에서 뺐다.** `/admin/api/2024-01/orders`(Shopify Admin API의 실제
  형태)에서 그건 실행별 값이 아니라 **고정된 API 버전**이고, 자르면 그 버전의 모든 엔드포인트가 서로를
  만족시킨다. 월별 아카이브도 같다. 내가 세운 순위(false GREEN > false FAIL)를 그대로 적용한 결과다 —
  월별 리포트 경로를 안 자르는 건 시끄러운 실패라 더 싸다. `YYYY-MM-DD`는 그대로 컷.
  ④ 숫자 조각 하한을 5 → **6자리**로 올렸다. `CVE-2024-21413` 같은 **고정 공개 식별자**를 살리기 위해서고,
  잃는 건 숫자 그룹이 정확히 5자리인 id뿐이다. 코퍼스의 KNOWN GAP도 합성 문자열 대신 **실물 포맷**
  (Stripe `cus_…`, KSUID, Hashids)으로 바꿔 "희귀한 모양"이 아니라 "주류 생성기"임이 표에서 읽히게 했다.
- **7차 교차검증 → 프리즈 쪽 결정성 누수 + 실패 응답 동결:**
  ① **얼린 method가 제안이 아니라 도착 순서를 반영했다.** 같은 URL·status에 GET과 POST가 둘 다 있으면
  먼저 온 쪽이 매칭돼, **같은 증거가 실행마다 다른 강도로 얼려진다**(GET이 먼저면 method 없는 약한 체크,
  POST가 먼저면 method 포함). 재생 결정성(불변식 #4)이 프리즈 쪽에서 새는 자리고, 프롬프트 예시 JSON에
  method 필드가 없어 **제안 대부분이 methodless라 흔한 경로**다. 게다가 그 약한 체크가 #184 게이트를
  끄는 증명으로 카운트된다. 제안에 method가 없으면 **mutation 매칭을 우선**하게 했다.
  ② 반대 방향도 있었다 — 제안이 명시적으로 `GET`이라고 말하면 #105("매칭이 mutation일 때 method를 얼린다")가
  **그 GET을 소리 없이 지워** 제안보다 넓은 체크를 만들었다. 제안이 method를 말하면 그걸 얼린다.
  ③ **실패 응답을 성공 증명으로 얼 수 있었다** — `status: 500` 제안이 500 요청에 매칭되면 그대로 얼려져,
  재생은 그 API가 **다시 500으로 실패해야** 통과한다. `freshMutationExpect`가 요구하는 2xx/3xx 상한을
  여기도 뒀다. 4xx/5xx 검증은 사용자 기준(`origin: user`)의 몫이지 파생 단언의 몫이 아니다.
  **이게 두 경로 비대칭의 세 번째 사례라 패턴으로 취급한다** — `freshMutationExpect`에 있는 조건이
  `deriveAssertions`에 없으면 일단 의심한다. 남은 차이는 `isBenignRequest` 하나인데, benign은
  "실패를 무시한다"는 뜻이지 "액션이 아니다"가 아니라 의미가 달라 그대로 뒀다.
  ④ 모델이 제안한 `navigated.to`가 관측값과 다르면 이제 trace에 남는다(성공 페이지를 기대했는데
  에러 페이지에 앉은 경우가 사람이 봐야 할 신호다). 드롭 사유에도 method를 넣었다 — URL·status가 맞는
  요청은 실제로 있었으므로 종전 문구는 없는 요청을 찾게 만들었다.
  ⑤ 코퍼스 노트 2줄이 옛 규칙을 말하고 있어 고쳤고(`YYYY-MM[-DD]` → `-DD` 필수, "5자리 미만" → "6자리 미만"),
  **이번에 의도적으로 내준 것 둘**(숫자 그룹 5자리 id, 월별 리포트 경로)을 표에 추가했다.
  `python2to3`는 `utf8ToUtf16`과 같은 가족의 소문자 절반이라 그 항목 옆으로 옮겼다.
- **8차 교차검증 → benign 판단 정정:** 내가 7차에서 "benign은 실패를 무시한다는 뜻이지 액션이 아니라는
  뜻이 아니다"라며 그대로 뒀는데, **증명으로 쓰일 때는 정반대**라는 반론이 맞다. 제품이 어떤 엔드포인트를
  benign으로 표시하는 이유는 그게 **부수적**이기 때문이고, 그걸 액션의 증명으로 세우면 표시의 의미가 뒤집힌다.
  실측 예: `benign: ["analytics.co"]`인데 `POST analytics.co/collect 200`이 유일한 "액션 증명"으로 얼려지고,
  그 체크가 비항진 `request-status`로 카운트되어 **#184 게이트까지 끈다**. 트래킹 비콘은 어디에나 있고
  제품이 benign으로 표시하는 대표 대상이라 방아쇠도 현실적이다. `groundingMatch`가 benign 요청을
  후보에서 제외하게 했다.
  **남은 절반(스텝 expect):** `freshMutationExpect`는 built-in 목록만 적용하고 **제품 목록을 인자로 받지도
  않는다** — 즉 두 경로의 비대칭이 아니라 양쪽 다 뚫린 구멍이었다(리뷰어도 자기 지난 진단을 정정했다).
  이쪽은 `discover → assignStepExpects → freshMutationExpect` 시그니처를 넓혀야 하고, 그 함수는 #182가
  이미 옵션 인자를 추가해 건드리는 중이라 **#182 머지 후 한 번에** 하는 게 리베이스 충돌을 줄인다.
  후속으로 남긴다.
- **8차 minor:** 새로 넣은 `navigated.to` 불일치 신호가 생문자열 비교라 형식 차이(스킴·트레일링 슬래시)에
  오작동했다 — 모델이 같은 목적지를 다른 표기로 말하면 없는 불일치를 매번 보고해 **신호가 자기 노이즈에
  묻힌다.** 판정에 쓰는 `urlReached`로 비교하게 고쳤다.
- **9차(최종) minor:** benign으로 제외된 제안의 드롭 사유가 "일치하는 요청이 없다"고 말했는데,
  **요청은 실제로 있었고 노이즈로 치워졌을 뿐**이다. 지난 라운드에 method를 사유에 넣은 것과 같은 이유로
  "해당 엔드포인트가 benign으로 표시돼 있다"고 구분해 말하게 했다 — 읽는 사람이 없는 요청을 찾게 되면
  고칠 곳을 못 찾는다.
- **메인테이너 리뷰(PR #178 코멘트) → 정규화가 판정력을 "소비"하면 얼리지 않는다:** 읽기 전용 플로우에는
  우선할 mutation이 없어서, `/api/products/586738` 제안이 `shop.co/api/products`로 얼려지고
  **페이지가 자기 목록을 부르는 `GET /api/products`가 그걸 이미 만족**시킨다 — 상세를 안 여는 재생도 통과한다.
  develop은 이 자리에서 빨갛게 죽었으니(#172의 false FAIL) 이 브랜치가 **시끄러운 실패를 조용한 통과로
  바꾸는** 셈이다. 대응: 얼릴 값이 **증명한 요청과 다른 형태의 요청까지 매칭**하면 그 단언을 드롭한다.
  판별은 `sameEndpointShape` — 세그먼트 수가 같고 다른 자리는 양쪽 다 동적일 때만 같은 엔드포인트로 본다.
  **메인테이너 문구("제안보다 넓게 매칭하면 드롭")를 그대로 쓰지 않고 좁힌 것은 의도적이다** — 문자 그대로면
  #172의 원래 케이스(한 액션이 두 번 발화, 실행별 id로만 다름)까지 드롭돼 이 PR의 목적이 무너진다.
  **부수 효과로 동사 손실 HIGH가 한 런에서 confirm·cancel이 둘 다 관측될 때는 닫힌다** — 하나만 관측되면
  여전히 남으므로 코퍼스의 `VERB LOST:` 행과 그 설명을 그 사실에 맞게 고쳤다.
- **미해결(리뷰 지적, 이 PR 밖):** ① 쿼리로 오퍼레이션을 가르는 API(`/graphql?op=AddToCart`)는 쿼리를
  통째로 버리므로 행위 증명이 사라진다 — 값만 정규화하려면 "실행별로 변하는 값" 판별이 따로 필요하고
  별도 결정 사안. ② host-only drop은 fail-closed가 아니다 — 비항진 `navigated`가 하나라도 남으면
  행위 증명 없이 GREEN이 된다. CLI 경고로 노출하려면 discover→CLI 반환 채널(현재 없음)이 필요.
- **state 변화:** #172 close. #171 착수 시 "단언·스텝 expect 양쪽의 host 고정"을 한 세트로 볼 것.
  후속 후보 2건(위 미해결)은 이슈로 등록 여부 판단 필요.
