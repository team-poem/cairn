# 2026-07-07 — explore 모드: freeze-less 자율 UX 탐색 (#102, 브랜치 `feat/102-explore-mode`)

## 무엇을

`explore(charter, opts)` — discover 루프의 freeze-less 자매 함수(`src/core/explore/`).
같은 기계장치(관찰→결정→실행, ActionPolicy, 실패 메모리, 요소 랭킹, UsageMeter)를 재사용하되
Scenario를 동결하는 대신 charter 아래 앱을 배회하며 **findings**를 수집해 `ExploreReport`로 반환.

- 기계 도출(순수 함수, critic과 같은 benign/recovered 잣대): `failed-request` ·
  `console-error` · `dead-action`(click/select가 성공했는데 이동·요청·렌더 변화 전무) ·
  `action-error` · `slow-settle`.
- 모델 직접 기록: 새 `note` 결정 → `agent-note` finding (혼란스러운 상태, 막다른 길 등).
- 프롬프트: 액션 어휘를 discover와 공유 상수(`ACTION_VOCABULARY` 등)로 추출해 어휘 드리프트
  구조 차단(#99 계열, SYSTEM 바이트 동일). 방문지 커버리지 메모리 + 기록된 findings 재기록 금지.
- 관찰은 턴당 1회(settle+observe+snapshot)를 이전 행동의 outcome이자 다음 결정의 입력으로
  재사용 — 행동당 관찰 2회 비용 없음 (discover의 retroactive mark #81과 같은 스탠스).
- `renderExploreReport` 순수 마크다운 렌더러(Reporter 포트는 verdict 형이라 미사용).
- CLI `cairn explore "<charter>" --url <u> [--report] [--json]`, error급 finding → exit 1.
- 불변식 #4 가드: replay 경로가 core/explore를 import하지 않음을 테스트로 강제.

## 검증

- 유닛 22개(findings 테이블 주도 + 루프 scripted + 불변식 가드), 전체 332/332 ·
  typecheck · build 그린.
- 도그푸딩(로컬 데모샵, 심은 버그 3종, haiku, max-steps 10):
  - 심은 500 결제 API → `failed-request` + 동반 `console-error` 검출 ✓
  - 죽은 클릭 → `dead-action` 검출 ✓ (모델이 홈에서 Home 링크를 눌러 자연 발생)
  - 환각 요소 클릭("Shop") → `action-error` + 실패 메모리로 재시도 차단 ✓
  - 존재하지 않는 /shop 직행 → 404 `console-error` 검출 ✓
  - truncated 경고·커버리지·비용(llm 10콜) 리포트 정상 ✓

## 알려진 한계 / 후속 후보

- **페이지 로드 시점(첫 행동 이전) 콘솔 에러는 안 잡힘** — findings가 행동 델타 기반이라서.
  시드 goto에도 mark를 뜨면 해결(v1 스코프 아웃).
- haiku는 짧은 페이지에서도 scroll 배회가 심함 — ActionPolicy로 연속 scroll 캡을 거는
  프리셋 정책(예: `wanderPolicy()`)을 엔진이 제공할 가치 있음.
- perception층(스크린샷 diff)은 #104 합류 지점. 멀티페이지 URL frontier 크롤링이 아닌
  charter 유도 배회 — 커버리지는 maxSteps·charter 문구에 의존.

## state 변화 (머지 후 develop에 반영할 것)

- 루프의 두 번째 소비자 `explore` 추가(#102 구현) — "탐색의 유연함"이 freeze 없이도 제품 가치
  (자율 UX 탐색 리포트)로 노출됨. discover와 어휘·정책·실행 경로 공유, replay 경로 불변.
