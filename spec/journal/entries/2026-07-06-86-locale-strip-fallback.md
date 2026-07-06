# 2026-07-06 — #86 로케일 스트립을 2단 매칭 + 주입 옵션으로 (형질≠사실)

- **브랜치:** `fix/86-locale-strip-fallback` (#96 위에 스택, 묶음 A의 2번)
- **근원:** `localeStrippedKey`가 "첫 세그먼트 2글자 = 로케일" 정규식으로 무조건 스트립 —
  #56 픽스가 앱 형질을 보편 휴리스틱으로 승격한 것. 실존 라우트(`/my`,`/go`,`/tv`)가 삼켜져
  `urlReached("…/", "…/my")`가 true → expect가 이미-참으로 판정 → 클릭이 조용히 skip.
- **수정 (이슈 제안대로 리스트 정교화 아님 — 설계 장치 ① 적용):**
  1. **2단 매칭** — 1단: 로케일 해석 0의 직접 경계 매칭(실존 라우트는 자기 자신으로 매칭).
     실패 시에만 2단: 로케일 스트립 폴백.
  2. **주입 seam** — 스트립 대상 프리픽스 = 소비자 주입(`UrlMatchOptions.localePrefixes`,
     파이프라인 표면 `RunHarnessOptions.localePrefixes`, benign 리스트와 같은 패턴).
     엔진 기본 = 보수적 리스트 `DEFAULT_LOCALE_PREFIXES = ["en","ko","ja","jp"]`
     (기존 테스트의 ko/jp↔en 동작 보존; region 변형 `en-US`는 base `en`으로 매칭). `[]`면 폴백 off.
  3. **skip 가시화** — `runStep` 사전체크 skip 시 `ExecutedAction.skipped` + `StepProgress.skipped`
     마커. 이 실패 계열(#56→#86/#87/#96)이 다시는 무음이 되지 않게.
- **스레딩:** `RunHarnessOptions.localePrefixes` → `runStep` → `conditionMet`/`pollCondition`(→
  `urlReached`). `run.ts`(`RunScenarioOptions`) 패스스루와 critic(`navigated` 단언의 urlReached),
  `waitForCondition`(waitFor 스텝)은 **미주입(기본 리스트 사용)** — solp721 소유 파일이라 보고로 대체.
- **테스트:** 188 → 216. URL 코퍼스 `URL_REACHED_CORPUS`(22케이스: 경계/로케일 유무/실존 2글자
  라우트/쿼리·해시/트레일링 슬래시/교차 로케일/비기본 로케일) + seam 주입 4 + 파이프라인 skip
  가시화·스레딩 2.
- **state 변화 제안:** #86 구현 완료. 공개 표면 신설(`localePrefixes` 옵션, `DEFAULT_LOCALE_PREFIXES`
  export) — 기본 리스트 구성은 메인테이너 사인오프 필요.

Assisted-by: Claude Fable 5
