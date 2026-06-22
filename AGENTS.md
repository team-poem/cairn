# AGENTS.md — cairn 개발 하네스

AI 코딩 에이전트가 이 레포를 수정하기 전에 따르는 규칙과, 어떤 문서를 읽을지
라우팅한다. 큰 문서를 통째로 읽지 말고 **작업에 맞는 가장 작은 문서만** 읽는다.

## 0. 세션 시작 — 먼저 읽기
- `spec/state.md` — 현재 상태·결정·다음 스텝(살아있는 핸드오프). 항상 먼저.
- 작업이 설계에 닿으면 `spec/architecture.md`.

## 1. 라우팅 — 작업 종류 → 문서
- 코어/파이프라인/인터페이스(`packages/harness/**`) → **`spec/architecture.md` 필수.**
- QA 앱(`packages/qa/**`) → `spec/architecture.md` + (코드 규칙은 생기는 대로 `spec/code/`).
- 제품 설계 전반·맥락 → `docs/design.html` (요약: `spec/design.md`).
- 코드 스타일 문서는 코드가 쌓이면 `spec/code/`에 추가한다. **지금은 미리 쓰지 않는다.**

## 2. 설계 불변식 — 깨지 말 것
`packages/**`를 건드리면 `spec/architecture.md`를 읽고 불변식
(패턴≠데이터 / 인터페이스로만 확장 / 루프는 탐색만 / 재생은 결정적 / 의존방향 qa→harness)을
지킨다. `.claude/hooks/route.sh`가 이를 자동으로 상기시킨다.

## 3. Spec Reference Disclosure
코드 작성·수정 **직전**, 어떤 spec 문서의 어떤 규칙을 적용하는지 한 줄로 밝힌다.
> 이 작업은 [종류]라 [`spec/...`]의 [규칙]을 참고해 작성합니다.

전체를 요약하지 말 것 — 포인터만. 규칙이 변경과 충돌하면 끝에 그 사실을 보고한다.

## 4. Verify before done — 완료 조건
"끝났다" 선언 전에:
- 타입체크·빌드·테스트 통과(있으면).
- 가능하면 **도그푸딩** — cairn 자신으로 한 번 돌려본다.
- review 단계(생기면 `spec/code/.../review-checklist.md`) 통과.

## 5. 메모리 갱신 — 완료 후
- `spec/state.md` — 바뀐 현재 상태·새 계약·다음 스텝으로 갱신(작게 유지).
- `spec/history.md` — 이번 작업을 append(과정·결정·결과). 길어지면 `spec/archive/`로 이관.

## 6. 규칙 진화
작업 중 반복되는 결정이나 규칙 충돌이 보이면 `spec/state.md`의 **"규칙 후보"**에
한 줄 적어둔다. 반복되면 정식 규칙(`spec/code/...`)으로 승격한다.

## 7. 컨벤션
- 코드·식별자·주석·에러 메시지는 **영어**. 사용자와의 대화만 한국어.
- 커밋은 작고 의미 단위로.
