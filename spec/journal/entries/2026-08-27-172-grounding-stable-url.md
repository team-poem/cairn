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
- **state 변화:** #172 close. #171 착수 시 "단언·스텝 expect 양쪽의 host 고정"을 한 세트로 볼 것.
