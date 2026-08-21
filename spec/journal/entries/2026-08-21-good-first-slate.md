# 2026-08-21 — good-first 슬레이트 정리: 묶음 R(레포 위생) + 묶음 E(엔진 소품)

- **브랜치:** `chore/repo-hygiene-slate`(R) · `feat/engine-small-slate`(E) — 7/21 등록 후 한 달간 미착수였던
  #146–#152 + #156을 우리가 직접 정리. 파일 영역으로 두 묶음, 이슈당 커밋.
- **R — `.github/` + 문서 (엔진 코드 0줄):**
  - #151 액션을 Node 24 런타임 메이저로(checkout v7·setup-node v7·github-script v9; create-github-app-token은
    이미 최신 v3.2.0). 릴리스 PR 로그에 뜨던 deprecation 경고의 실체.
  - #156 verify에 `core/` node: 내장 import 가드(주석 제외 grep, 실패 시 `::error`). #155 리뷰에서 잡힌
    browser 엔트리 파손 재발 방지 — 현재 core/는 clean 확인.
  - #152 이슈 폼 2종(bug/feature) + config(디스커션 링크). 둘 다 "PR은 이슈 링크 필수"를 앞에 명시.
  - #148 CONTRIBUTING 브랜치 prefix 5종을 가드 allowlist와 일치시키고 오프컨벤션 자동 클로즈 명시.
- **E — 엔진 소품:**
  - #146 CLI `--help/-h`·`--version/-v`(+ `help`/`version` 서브커맨드). 실기: exit 0, 미지 커맨드는 여전히 exit 2.
  - #149 `core/requests.ts` 전용 테스트(JSDoc 계약 그대로 15케이스).
  - #150 `renderExploreReport`·`renderSuiteReport` 출력 고정 테스트(9케이스).
  - #147 양쪽 README에 `discover --semantic`과 replay 트레이드오프(해당 체크만 LLM critic 필요) 문서화.
- **검증:** R = YAML 4파일 ruby 파싱 + 가드 정규식 실증(나쁜 import 1건 검출·주석 무시) · E = typecheck·449 테스트
  (+24)·build·CLI 실기.
- **state 변화:** 오픈 이슈 12 → 4(#8·#101·#103·#104 — 논의 3 + 벤치 1)로, 다음 사이클은 러너 트랙 + #101 결정만 남음.
