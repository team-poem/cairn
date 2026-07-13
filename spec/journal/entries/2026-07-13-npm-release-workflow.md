# 2026-07-13 — npm 자동 릴리즈 GitHub Action 추가

- **브랜치:** `main` (인프라 변경 — 코드 아님)
- **계기:** PR #134(2.5.0, `develop` → `main`)가 대기 중인 상태에서, 지금까지 수동이던
  npm 배포(`npm publish` 개인 토큰 → `git tag` → GitHub Releases 웹 작성)를 자동화 요청.
- **구현:** `.github/workflows/release.yml` — `main` push 트리거. `packages/harness/package.json`의
  버전이 npm에 이미 있으면 전부 스킵(idempotent, 버전 안 올린 push에도 안전). 새 버전이면
  build → test → `npm publish` → `git tag vX.Y.Z` push → `gh release create --draft --generate-notes`.
  릴리스 노트는 draft만 자동 생성, 발행은 여전히 수동(사용자 요청: 노트는 직접 다듬어서 올림).
  태그/릴리스가 이미 존재하면 건드리지 않고 `::warning::`만 남김(기존 걸 덮어쓰지 않음).
- **필요 secret:** `NPM_TOKEN` — 아직 repo에 없음. 사용자가 npmjs.com에서 granular access
  token(publish 권한, `cairn-engine` 스코프, 2FA bypass) 발급 후 직접
  `gh secret set NPM_TOKEN`(터미널에서, 대화창 아님)으로 등록해야 함. **아직 미등록 —
  등록 전까지 워크플로는 checkout까지만 돌고 publish 단계에서 인증 실패.**
- **발견한 기존 불일치:** `v2.5.0` 태그 + GitHub Release가 이미 존재하는데, 그 태그가 가리키는
  커밋은 현재 `main` HEAD(2.4.0 머지 커밋) — 실제 2.5.0 코드는 아직 `develop`에만 있고
  PR #134가 머지되기 전. 워크플로는 기존 태그/릴리스를 자동으로 옮기지 않으므로, PR #134가
  머지된 뒤 `v2.5.0` 태그를 새 머지 커밋으로 수동 이동(`git tag -f` + force push)해야
  릴리스가 실제 코드를 가리키게 됨 — 다음 세션에서 확인 필요.
- **문서 갱신:** `CONTRIBUTING.md`의 `## Releases` 섹션을 새 자동화 흐름(태그·npm publish·draft
  release는 CI가 수행)에 맞춰 갱신, `NPM_TOKEN` secret 요구사항 명시.
- **state 변화:** 없음 (인프라 후속 조치 — `NPM_TOKEN` 등록 여부와 `v2.5.0` 태그 정정만 다음
  세션에서 확인하면 됨. `state.md` 자체는 develop에서만 갱신하므로 이번엔 건드리지 않음).
