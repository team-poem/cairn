# 2026-07-08 — select를 a11y-native 우선으로 재구현 + 동사 추가 가드레일(불변식 #7)

- **브랜치:** `fix/select-aria-native-dropdown` (develop = 2.5.0 개발선)
- **문제(실측):** delivered 확장 도그푸딩 — 필수옵션 상품의 옵션 선택기가 네이티브 `<select>`가 아니라
  `button[role=combobox]`+listbox 포탈(MUI 류). 현 `select`가 `type`과 같은 `fill` 프리미티브를 써서
  커스텀 드롭다운엔 **조용히 no-op** → discover가 26스텝 열고·고르고·재열기 반복하다 한도 소진.
- **설계 판단(리뷰어 2 + 세션 합의):** 관계가 뒤집힌다 — **a11y-native "열기→고르기"가 일반, 네이티브
  `<select>.value`가 특수케이스.** `select`는 `type`과 같은 고도(다단계 메커니즘을 한 의도 뒤에 숨김) →
  새 Step이 아니라 기존 `select`의 순진한 구현을 고치는 것. 옵션 B(제거 후 click 2번)는 포탈 타이밍·heal
  다발·freeze 불안정으로 기각.
- **두더지잡기 공포의 진짜 봉쇄 = 불변식 #7:** "ARIA 역할이면 엔진"(너무 넓음)도 "표현 가능하면 금지"(드롭다운이
  click-표현 가능한데 조합은 틀린 설계 → 반례)도 아님. 기준 = **"단일 의도가 조합보다 더 안정적으로 freeze되는가"**
  + **실측 게이트**(조합이 깨지는 걸 실제 페이지에서 봤을 때만) + **이슈 합의**. 추측으로 미리 동사 안 만듦 →
  "동사가 어디까지 늘지 모른다"가 "실측으로 깨진 것만 그때그때"로 바운드. `spec/architecture.md` 불변식 #7 + 체크리스트.
- **구현(드라이버 어댑터 내부만, 엔진 표면 무변경):**
  - **커밋 1**(`63fa0be`): `isNativeSelect`(in-page tagName 프로브 — a11y role은 네이티브·커스텀 둘 다 `combobox`라
    구분 불가)로 판별, 커스텀이면 no-op 대신 **throw**(fail-closed, #127 "추측 말고 실패" 일관).
  - **커밋 2**(`9c91d13`): 커스텀이면 **열기 → 오픈 후 새로 뜬 option만(워터마크) → `value` 이름 매칭 클릭.**
    워터마크가 네이티브 select의 상시 존재 옵션 오매칭을 차단. exact→단일 substring, 다중 exact는 거부(#127).
    결정적 문자열 매칭(LLM 0). `select` 한 스텝이 컨트롤 대상 단일 안정 단위로 freeze 유지.
  - **커밋 3**(`dabeb24`): 불변식 #7 spec.
- **검증:** typecheck·build·**352 테스트**(네이티브 fill fast-path · 커스텀 open+pick 워터마크 · no-option throw).
  실브라우저 픽스처(네이티브 `<select>` + MUI류 커스텀) 도그푸딩 통과 — 커스텀 값이 실제로 반영됨.
- **분리:** 이름 `select`가 `<select>` 태그를 연상시켜 오해를 낳은 건 맞지만, 개명은 frozen 포맷+프롬프트 어휘 =
  breaking → 이 픽스와 분리(후속 별도 결정).
- **state 변화:** 불변식 #7 신설. select는 커스텀 ARIA 드롭다운까지 커버(엔진 표면 무변경). 2.5.0行 작업 누적.
- **이슈:** §6대로 GitHub 이슈는 개인 계정으로 사람이(회사 gh 금지). 초안 제공 가능.
