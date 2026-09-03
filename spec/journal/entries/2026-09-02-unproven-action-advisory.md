# 2026-09-02 — 검증 불가능한 액션 게이트를 advisory로 낮추고 같은 사이트로 조준 (#184 리뷰 반영)

- **브랜치:** `fix/unprovable-action-fails-closed` (PR #184, 리뷰 코멘트 대응)
- **배경:** 리뷰어가 세 가지를 지적했다. ① heal 경로가 게이트를 우회한다(`withProvenAction`은
  pipeline에만, outcome-heal은 `critic.judge`를 그대로 반환; `runSuite`는 heal 기본값 true).
  ② 워터마크가 첫 mark 이후를 전부 플로우 트래픽으로 보고, 액션이 없으면 `?? 0`이라 진입 로드
  전체를 센다. ③ `api2.amplitude.com/2/httpapi`처럼 서드파티 분석 비콘의 첫 세그먼트가 숫자라
  Amplitude 앱의 읽기 전용 테스트가 매번 빨개진다. #169(신뢰도 벤치)가 없어 오탐률을 측정할 수
  없으니 **advisory로 먼저 landing하고 측정 후 fail-closed로 뒤집자**는 제안. 수용했다.
- **구현:**
  - **advisory.** `withProvenAction`을 pipeline에서 제거했다. 재생 verdict는 플래그를 읽지 않는다.
    그래서 heal 우회는 고칠 대상이 없어졌다 — 우회할 게이트가 없다. fail-closed로 뒤집을 때는
    pipeline과 heal 두 경로가 같은 함수를 통과하게 만드는 것이 조건이다(리뷰 지적 ①을 그때 막는다).
  - **플래그가 URL을 담는다.** `Scenario.unprovenAction: true` → `string`(`"DELETE https://…"`).
    사람이 어떤 요청이 무장시켰는지 보고, #169에서 오탐을 분류할 수 있다. 미머지 필드라 형태 변경 자유.
  - **같은 사이트만.** `findUnprovenAction`(구 `hasUnprovenAction`, 요청을 반환)이 플로우가 밟은
    페이지(`marks[].url` + `finalUrl`)의 호스트이거나 그 서브도메인인 요청만 본다(`onSiteOf`,
    suffix 매치, 페이지의 `www.`는 무시). 분석 호스트 목록이 아니라 구조로 끊었다(불변식 #1
    패턴≠데이터). 크로스사이트 비콘(Amplitude·GA·Sentry)은 절대 안 세고, 같은 사이트 전송
    노이즈(SockJS)는 여전히 세며 `benign`으로 푼다. 처음엔 "마지막 두 라벨" 비교였는데 리뷰가
    `shop.co.kr` vs `other.co.kr`이 같은 사이트로 읽힌다고 잡아서 suffix 매치로 바꿨다 —
    public-suffix 목록 없이 ccTLD가 맞는다. 놓치는 건 `app.shop.co` 페이지가 `api.shop.co`를
    못 잡는 경우이고, 조용한 쪽이다.
  - **리뷰 대응 중 사고:** 테스트 블록을 교체하면서 바로 뒤의 #178 리뷰 테스트 6개를 함께 지웠다.
    리뷰어가 잡았고 develop에서 그대로 복원했다.
  - **워터마크.** 액션이 없으면 `baseline.logic.requests.length`(settle 후 진입 로드 끝)로 떨어진다.
    도착 순서 문제(진입 로드가 쏜 비콘이 첫 mark 뒤에 도착)는 same-site 필터가 크로스사이트 쪽을
    없애고, 남는 같은 사이트 케이스는 SockJS와 같은 부류로 `benign` 처리. 완전 해결은 아니다.
  - **표면.** trace에 `gate: "unproven-action"`(action = `METHOD url`)을 추가하고, `cairn discover`가
    #180 경고 아래에 그 요청을 이름 지어 한 줄 더 찍는다.
  - **무관한 저널(2026-08-24 direction-interview)을 이 브랜치에서 뺐다.** develop 기준 별도 브랜치
    `docs/direction-interview-entry`에 커밋해 뒀다.
- **검증:** typecheck·build·674 테스트(+1: discover 레벨에서 플래그 문자열과 gate 이벤트). 유닛에
  Amplitude 크로스사이트 무시·경유 페이지 사이트 인정 추가. 실앱 도그푸딩은 안 돌림.
- **스펙:** `spec/core/judgment.md` fail-closed 규칙이 넷 → **셋 + advisory 하나**. 뒤집는 조건(#169
  측정)을 스펙에 적었다. `spec/core/trace.md` gate 목록에 `unproven-action`.
- **state 변화:** 후속 두 개 — (a) #169 벤치가 생기면 `unprovenAction` 플래그 빈도·URL을 세어
  fail-closed 전환 여부 결정, (b) 전환 시 pipeline·heal 판정 마무리를 한 함수로 통일.
- **규칙 후보:** 리뷰가 "측정 전에 fail-closed 금지"를 요구했다. 반복되면 judgment 규칙으로.
