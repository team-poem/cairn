# 2026-09-04 — request-status의 urlIncludes를 쿼리까지 매칭하도록 고침 (#200)

- **브랜치:** `fix/200-request-query-match` (`develop` 대상)
- **배경:** `findRequestStatus`가 `urlIncludes`를 `r.url.includes(...)` 순수 substring으로만
  검사해서 세 가지 오탐/누락이 있었다.
  1. **긴 오퍼레이션명이 짧은 프로즌 값을 우연히 만족** — `?op=AddToCart`로 프리즈한 체크가
     리플레이의 `?op=AddToCartV2`/`AddToCartAsync`에 그대로 만족됨(GraphQL 버저닝에서 흔한
     패턴). 가장 심각한 silent GREEN.
  2. **freeze 시점에 트레일링 슬래시가 쿼리를 통째로 날림** — `capture.ts`의
     `stableEndpointPrefix`가 `url.includes(path + query)`로 가드했는데,
     `https://shop.co/rpc/?action=checkout`은 `rpc/?`와 `rpc?`가 달라 이 substring이 실패,
     `path`(쿼리 없는 값)로 폴백해 쿼리가 영구히 사라짐.
  3. **쿼리 파라미터 순서에 민감** — `?op=AddToCart`가 `?trace=xy&op=AddToCart`나 재정렬된
     쿼리에 대해 실패.
- **구현:**
  - `core/requests.ts`에 `urlMatchesFrozen(url, urlIncludes)` 추가 — `?` 앞은 여전히 substring,
    `?` 뒤는 파싱한 key=value 쌍의 **subset 매칭**(프로즌 쌍이 모두 같은 값으로 존재해야 함,
    extra param 허용, 순서 무관). `findRequestStatus`가 이걸 쓰도록 교체.
  - `discover/capture.ts`의 `stableEndpointPrefix` 가드를 `url.includes(path + query)`에서
    `url.includes(path)`로 좁힘 — 쿼리는 더 이상 리터럴로 안 붙으니 path만 실제로 URL에 있으면
    된다. `stableQuerySuffix` 자체(leading-run 컷)는 이번 PR에서 건드리지 않음, 주석에
    "이제는 subset 매칭이라 contiguity가 필수는 아니지만 별도 변경" 한 줄만 추가.
  - 동일한 containment를 손으로 하던 4곳을 모두 `urlMatchesFrozen`으로 교체(검증과 진단이
    어긋나지 않도록): `discover/grounding.ts`의 `groundingMatch`(mutation 분기),
    "spent"(정규화된 값이 다른 엔드포인트와 충돌하는지) 체크, "no captured request matched"
    진단의 setAside 계산, `adapters/critics/assertion.ts`의 "near" 진단 목록.
  - `Scenario`의 `urlIncludes`는 여전히 plain string — JSON 스키마 변경 없음.
  - 프롬프트 문구 갱신: `discover/prompt.ts`의 `ACTION_VOCABULARY`(waitFor.requestStatus만,
    `until.url`은 그대로 substring), `discover/grounding.ts`의 assertion-proposal 프롬프트.
    최종 문구는 PR 리뷰 라운드 2에서 한 번 더 갱신됨 — 아래 참고.
- **테스트:**
  - `test/core/requests.test.ts` — `urlMatchesFrozen`/`findRequestStatus`에 shape 1(더 긴
    op이 만족 못 함)·shape 3(extra param 허용, 순서 무관, 누락 param은 실패) 케이스 추가.
  - `test/support/url-corpus.ts`의 `STABLE_PREFIX_CORPUS` — 기존에 버그를 그대로 핀해둔
    케이스(`"trailing slash before the query keeps the path only" → "shop.co/rpc"`)를
    고친 기대값(`"shop.co/rpc?action=checkout"`)으로 갱신. **기존 테스트를 수정한 유일한
    지점** — 이 케이스가 버그 자체를 회귀 고정하고 있었으므로, 픽스가 그 기대값을 정당하게
    바꾼다.
  - `test/core/discover/grounding.test.ts` — freeze/grounding 시점에도 `AddToCartV2` 같은
    변형이 잘못 그라운딩되지 않고 "no captured request matched"로 드롭되는 걸 확인(사이트
    269/149 커버).
  - `test/adapters/critics/assertion.test.ts` — replay 시 shape 1이 거부되고, near-miss
    진단도 "no request matching"으로 일관되게 나오는지 확인(사이트 62).
  - `test/core/discover/prompt.test.ts`, `test/core/explore/prompt.test.ts` — SYSTEM/
    EXPLORE_SYSTEM 바이트 고정 스냅샷을 새 문구로 갱신(§99 의도대로 명시적 diff로 남김).
- **검증:** `npm test` 861 passed, `npm run typecheck` 통과.
- **닫힌 범위:** shape 1·2·3 모두 픽스. `discover/grounding.ts:192`("spent" 체크)는 코드는
  옮겼지만 `sameEndpointShape`가 쿼리를 안 보고 path만 비교해서 쿼리만 다른 두 엔드포인트를
  애초에 "다른 엔드포인트"로 잡아내지 못하는 기존 한계가 있어(스코프 밖 — `sameEndpointShape`
  변경 금지) 이 지점만 별도 회귀 테스트는 안 붙였다.
- **state 변화:** 없음(작업 브랜치라 `state.md` 미수정, §5).

## 커밋 후 갱신 1 — types.ts 문서 주석 (PR #201 리뷰)

- `core/types.ts`의 `WaitUntil.requestStatus`, `Assertion`의 `request-status` 분기 doc comment가
  옛 순수 substring 시맨틱을 그대로 설명하고 있어서, `urlMatchesFrozen`을 가리키는 문장으로
  갱신(`96acb7a`에 amend). 기존 커밋에 amend — 아직 push 전이었음.

## 커밋 후 갱신 2 — PR #201 리뷰 라운드 2, 세 건

리뷰가 실제 회귀 하나를 잡아냈다(팀리드가 재현 확인 후 전달).

1. **`hasStablePath`가 쿼리 값 안의 `/`로 오탐** — 우리 가드 변경(`stableEndpointPrefix`가
   이제 쿼리를 붙여 리턴) 이후, `hasStablePath(prefix)`가 여전히 `prefix.includes("/")`라서
   `"shop.co?next=/dashboard"` 같은 프리픽스가 "path 있음"으로 잘못 판정됨. host-only 체크가
   프리즈되고, 쿼리만 다른 무관한 요청에도 만족되는 false GREEN(#172가 막으려던 바로 그것).
   호출부 3곳(`capture.ts:112`, `grounding.ts:181`, `grounding.ts:325` — 이건 #184
   unproven-action 게이트를 무장해제하는 부작용까지 있었음) 대신 `hasStablePath` 안에서
   `?` 앞부분만 보도록 고침. 회귀 테스트: `capture.test.ts`(`freshMutationExpect`가
   `?next=/dashboard`짜리 root POST를 여전히 host-only로 거부), `grounding.test.ts`
   (`findUnprovenAction`이 같은 요청을 여전히 unproven으로 잡아냄, #184 케이스).
2. **프롬프트가 "쿼리 값은 정확히 일치해야 함"을 말하지 않음** — 그라운딩은 부분 값
   (`?op=Add` vs 실제 `?op=AddToCartMutation`)을 이미 올바르게 거부하는데, 문구는 모델에게
   "pair를 추가할 수 있다"만 알려줬다. `discover/prompt.ts`의 `ACTION_VOCABULARY`와
   `discover/grounding.ts`의 assertion-proposal 프롬프트를 `<url-path-substring, optionally
   with ?key=value pairs that must match exactly (no partial values)>`로 갱신. SYSTEM/
   EXPLORE_SYSTEM 바이트 고정 스냅샷 두 곳도 같이 갱신.
3. **waitFor/step expect 경로에 #200 테스트가 없었음** — `conditionMet`/`findRequestStatus`
   (`steps.ts:231`)는 매처 변경과 freeze 가드 변경 두 번 다 영향을 받는데 커버리지가 없었다.
   `steps.test.ts`에 `conditionMetRequestStatusQuerySubset` 추가 — `?op=AddToCartV2`가
   프리즈된 `?op=AddToCart`를 만족 못 하고, 정확한 op(extra param 붙어도)는 만족함을 확인.
   (이 테스트는 추가하자마자 green이었다 — 매처 자체는 첫 커밋에서 이미 고쳐져 있었고, 이번은
   순수 커버리지 추가.)
- **검증(라운드 2):** `npm test` 864 passed, `npm run typecheck` 통과, `npm run build` 통과.
- **커밋:** `96acb7a` 위에 새 커밋(amend 아님, 이미 push되어 리뷰 중이었으므로).
