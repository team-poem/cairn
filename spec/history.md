# history — 개발 기록 (append)

> 각 항목: 날짜 · 목표 · 한 일 · 결정 · 결과/이슈 · 다음 계약.
> 길어지면 오래된 항목을 `spec/archive/`로 이관.

---

## 2026-06-22 — 개발 하네스 스캐폴딩
- **목표:** AI 에이전트가 cairn을 일관되게 개발하도록 규칙 체계 구축.
- **한 일:** `AGENTS.md`(라우터) + `CLAUDE.md`(심링크), `spec/{architecture,state,history,design}.md`,
  PreToolUse 라우팅 훅(`.claude/hooks/route.sh` + `.claude/settings.json`).
- **결정:** vibe 하네스를 베이스로 — 라우터·disclosure·history는 채택, 개량으로
  (1) 경로 기반 자동 라우팅 훅 (2) state/history 메모리 분리 (3) verify-before-done
  (4) `architecture.md` 불변식 추가.
- **결과:** 파일 기반 하네스 + 라우팅 훅 구성. 코드 스타일 문서는 코드 생기면 추가 예정.
- **다음:** chrome-devtools-mcp 검증 → `packages/harness` v0.

## 2026-06-22 — 설계 정본(markdown) 추가
- **목표:** 에이전트가 읽기 좋은 설계 정본 확보.
- **한 일:** `docs/design.md`(정본) 추가, `docs/design.html`은 시각 버전으로 유지.
  확장점을 범용 인터페이스(`ContextProvider`/`Reporter`)로 정리.
- **결정:** 형태 = **CLI 우선**, 데스크톱 패키징은 확장 선택지. 라우팅 정본을 `docs/design.md`로.
- **다음:** chrome-devtools-mcp 검증 → `packages/harness` v0.
