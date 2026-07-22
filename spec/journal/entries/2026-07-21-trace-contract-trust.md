# 2026-07-21 — trace 계약 draft 착지(#138/PR #140) + 신뢰를 설계 기준으로

- **경로:** 디스커션 #125(방향) 닫힘 → #138(계약 설계, "designed for trust") → PR #140 `spec/core/trace.md` draft 머지.
  구현 아님 — 스펙 문서만. 구현은 후속(이벤트 sink seam).
- **신뢰 분석(계약의 설계 기준이 된 것):** 참조 글(Melody Koh, "Wrapping the Unpredictable Genius")의
  4층 제어 스택(모델→하네스→문서→훅, "맨 위층만 협상하지 않는다")과 **보장의 공식 — 진짜 보장 =
  사람이 미리 쓴 기준 × 코드 체크.** 이 공식의 두 축(기준을 누가 썼나 / 누가 검사하나)으로 cairn의 검증을
  4분면에 놓으면: suite 기계 `assertions` = 사람×코드(유일한 완전 보장, 최저 사용) · `expect` = 사람×모델 ·
  파생 단언 = 모델×코드(초록 불신의 본체) · 매 실행 LLM 판정 = cairn이 대체하려는 것.
- **적대적 검증 2라운드로 기각/정정된 것:**
  - 전수 freeze 비준 세리머니 기각 — 러버스탬프는 무비준보다 나쁨(도구에 알리바이). 살아남은 형태:
    사전 스펙 없는 discover-only 경로의 **첫 freeze + 단언 변경 시, 단언만** 리뷰(스냅샷 리뷰 유사물, 러너 백로그).
  - 엔진 비준 훅 기각 — **반환값/영속화 분리가 이미 그 seam**(discover·runScenario는 반환만, 저장은 호출자).
    러너(개발자 대상)는 git diff/PR이 공짜 재비준. 새 포트는 실수요 실측 때만(#7 정신).
  - 런타임 heal은 무인 유지, 게이트는 영속화에만. 신뢰 위계는 이원화 — 계약엔 인식론 라벨, UI는 이력·가시성으로 설득.
  - 발견된 최대 공백: **빨강의 신뢰(환경 flake)** — 스펙 소유권과 직교하는 별도 트랙(이슈로 개설 예정, amazon).
- **PR #140 리뷰(1라운드)에서 잡은 실질 결함 2 + 반영:**
  - **provenance 소실** — suite가 사용자 기준을 frozen 배열에 병합, `Assertion`에 출처 마커 없음 → `origin` 채울 수 없었음.
    반영: freeze가 단언에 `origin` 기록(additive), 3값 `user|derived|unknown`(구 skill은 unknown, fail-closed) +
    "Freeze-format implication" 섹션 신설.
  - **heal 1/3층만 매핑** — locator `Heal`·`StepHeal`·outcome-heal 3층 실재. 반영: heal 이벤트에 `layer: locator|step`,
    outcome-heal은 **`phase: heal` 아래 discover kinds**(phase=왜, kind=무엇), `judgedBy: original` 유지.
  - 잔짐: grounding drop 인용 #16→#99 · parse-retry를 `gate: parse-retry`로 흡수 · per-assertion 피드 유지 ·
    explore phase 보류(#7 정신) — "Decided in review"로 문서화. 오픈은 attachment id 스킴만.
- **구현 노트(후속 작업의 출발점):** 현 콜백(onStep/onHeal)로는 계약 방출 불가 — policy 블록·ambiguity 거부가
  동일한 onStep으로 보이고 parse-retry·grounding 드랍은 콜백 자체가 없음. 신규 **옵셔널 이벤트 sink seam** 필요
  (불변식 #2 부합; outcome-heal은 DiscoverOptions로 sink 스레딩 — policy/perceive와 같은 경로).
- **state 변화:** trace 계약 draft 머지 반영, 다음 = sink seam 구현 + flake 이슈. 러너 백로그에 freeze 리뷰
  화면(단언만·예외 구동) 추가.
