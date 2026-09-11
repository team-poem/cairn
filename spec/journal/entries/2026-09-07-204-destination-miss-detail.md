# 2026-09-07 — 목적지 미스가 설정 탓인지 말하기 (#204)

- **브랜치:** `fix/204-destination-miss-detail`.
- **문제:** `navigated` 미스가 앱이 딴 데 간 것과 매처가 이 앱의 선두 세그먼트(로케일·마운트·버전)를 모르는 것을
  같은 문구("did not reach X")로 냈다. 기본 `DEFAULT_LOCALE_PREFIXES`(#86) 밖의 앱은 stage 2가 아무것도 못
  벗기고 bare false → 설정 누락이 회귀처럼 읽힘.
- **변경:** `unrecognizedLeadingSegment(finalUrl, want, opts)` — stage 1 실패 후 **선두 세그먼트 하나**를
  벗겼을 때 매칭됐을 경우에만 그 세그먼트를 돌려줌(런 쪽·프리즌 쪽 모두 시도, 두 개 이상은 추측 안 함).
  critic의 `navigated` 미스 detail에 `; leading segment "de" is not a configured locale prefix`를 붙임.
  `urlReached`와 판정값은 불변. 이슈가 제안한 "stage 2가 아무것도 못 벗겼을 때"보다 좁게 잡은 이유: 그 조건은
  `/error`에 착지한 진짜 미스에도 참이라 힌트가 회귀에도 떠 버린다. 한 세그먼트 제거로 매칭될 때만 띄우면
  설정 미스에만 정확히 뜬다.
- **병렬 검증에서 고친 것:** 코퍼스 19개 미도달 행 + 적대적 형태로 돌려보니 (1) 런이 host 루트로 튕긴
  경우(인증 리다이렉트, 제일 흔한 진짜 미스)에 프리즌 첫 세그먼트를 접두로 제안 — 벗긴 쪽이 host만 남아 아무
  URL이나 매칭. 코퍼스의 #86 행(`x.co/` vs `x.co/my`)도 같은 원인. (2) 와일드카드 `*`를 접두로 반환. (3) 프리즌
  `/en/` vs 런 `/de/`(discover와 replay 환경이 다른 현실 케이스)를 놓침. → 벗긴 뒤 경로가 남아야 하고, `*`는 제외,
  설정된 접두를 먼저 벗긴 형태에서 탐색. 이슈의 원래 조건("stage 2가 아무것도 못 벗김")은 코퍼스 미도달 19행 중
  15행에 떴을 것(전부 거짓 양성); 최종 규칙은 0행.
- **문구:** `is not a configured locale prefix` → `is not in localePrefixes`. grep이 되는 이름으로.
- **이슈 후보 둘:** ① CLI(`run`·`replay`·`suite`)에 `localePrefixes`를 줄 플래그가 없어 힌트가 CLI 사용자에겐
  설정 불가한 것을 가리킨다(cases 파일 형식까지 걸려 별도). ② 스텝 `expect.url` 미스(`post-condition not met`)는
  같은 매처를 쓰는데 final URL조차 안 실리고, 설정 미스가 heal까지 유발한다. 같은 힌트를 거기에도.
- **안 한 것(이슈의 후속 둘):** 기본값을 `[]`로 바꾸는 것(기존 호출자 동작이 조용히 바뀜), 옵션 이름을
  로케일이 아닌 "선두 세그먼트"로 바꾸는 것(API 변경). 둘 다 별도 결정.
- **검증:** 헬퍼 9케이스(런 쪽/프리즌 쪽/stage 2 후 탐색/진짜 미스/루트 튕김/도달/두 세그먼트/와일드카드 제외/와일드카드 존중) + critic detail 4케이스.
  typecheck·build·check:boundaries·전체 테스트 통과.
- **상태 변화:** #204 종결. 2.9.0 슬레이트 남은 것 177(작음) → 196·197·198(설계).
