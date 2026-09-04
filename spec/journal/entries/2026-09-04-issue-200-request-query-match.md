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
    두 곳 다 `<substring, or add ?key=value pairs to also require those query params>`로.
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
