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
1. **(진행 중) chrome-devtools-mcp 검증** — 등록·연결 완료(✔, cairn 프로젝트 스코프).
   도구는 세션 재시작 후 로드됨.
   - 재시작: `cd ~/cairn && claude` 로 cairn 프로젝트에서 새 세션 시작.
   - 첫 테스트(수행 확인): "example.com 열고 → 첫 링크 클릭 → 그때 뜬 네트워크 요청 보여줘".
     이게 되면 = MCP가 탐색/관찰을 수행함 = harness Driver의 기반 OK.
2. `packages/harness` v0 — 최소 파이프라인(Context → Driver → Evidence → Critic → Report).

## 환경 메모
- chrome-devtools-mcp 등록됨: `npx -y chrome-devtools-mcp@latest` (Node 25, Chrome 설치 확인).

## 규칙 후보 (반복되면 승격)
- (없음)
