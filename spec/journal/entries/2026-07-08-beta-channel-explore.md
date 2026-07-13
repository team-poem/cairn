# 2026-07-08 — 2.5.0-beta 채널 개설 (explore, #102)

- **브랜치:** `develop` (버전 범프 + 저널만; explore 코드는 PR #123으로 기머지)
- **결정:** freeze-less **explore**(#102, PR #123)를 `latest`가 아니라 **별도 npm dist-tag `beta`**로 배포.
  대기업 관례(React `next`/`experimental`)의 prerelease + dist-tag 이중 채널.
- **왜:** explore는 실험 기능 — 안정선 소비자를 안 건드리면서 익스텐션이 `@beta`로 도그푸딩하게. explore는
  additive·격리 진입점(replay/discover 안정 경로가 core/explore를 import 안 함, invariant #4 테스트로 강제)이라
  코드가 안정선에 섞여도 무해하지만, **버전·채널로 실험 상태를 명시적으로** 분리.
- **한 것:** develop `2.4.0 → 2.5.0-beta.0` 범프 → `npm run build` → `npm publish --tag beta`(브라우저 CLI 인증 —
  granular 토큰 만료로 E404 → 토큰 없이 publish하면 auth URL로 붙음). 결과 `npm dist-tag ls`: `latest: 2.4.0, beta: 2.5.0-beta.0`.
- **규칙(안전장치, state 반영):** ① prerelease는 반드시 `--tag beta`(빠뜨리면 latest 오염). ② 안정 패치 2.4.1은
  main hotfix(develop 안 거침). ③ `develop → main`은 explore 정식화 결심 시에만 → `2.5.0` latest + `dist-tag rm beta`.
- **잔여:** git 태그 `v2.5.0-beta.0` + GitHub pre-release(latest 체크 X)는 미완 — 사람이 웹에서.
- **state 변화:** "지금 상태" 이중 채널로 갱신 · 배포 방법에 브라우저 인증 폴백 · 이중 채널 규칙 추가.
