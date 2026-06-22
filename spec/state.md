# state — 현재 상태 (세션 시작 시 먼저 읽기)

> 작게 유지. 사실·결정·다음 스텝만. 장황한 로그는 `history.md`로.

## 지금 상태
- 단계: **설계 완료, 코드 0.** 레포 스캐폴딩 + 개발 하네스만 존재.
- 확정: 이름 `cairn`, 모노레포(`packages/harness` + `packages/qa`), TS/Node, 라이선스 MIT.
- 설계 정본: `docs/design.md` (시각 버전: `docs/design.html`).

## 살아있는 계약/결정
- 아키텍처 불변식 → `spec/architecture.md`.
- 기본 드라이버: Chrome DevTools MCP.
- 형태: **CLI 우선.** 데스크톱 패키징은 확장 선택지.
- 환경별 적용은 커넥터(`ContextProvider`/`Reporter`) 플러그인으로.

## 다음 스텝
1. chrome-devtools-mcp 동작 검증 — MCP가 자연어 시나리오를 수행하나.
2. `packages/harness` v0 — 최소 파이프라인(Context → Driver → Evidence → Critic → Report).

## 규칙 후보 (반복되면 승격)
- (없음)
