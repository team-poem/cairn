# 2026-09-07 — 공개 경계로 실행하는 임베딩 예제 (#8)

- **브랜치:** `codex/8-package-boundaries`.
- **이유:** 소비자가 엔진 내부 파일에 의존하지 않고 설치부터 재생까지 실행할 수 있어야 한다.
- **변경:** CLI가 공개 entry만 사용하도록 정리하고 의존 방향 검사를 추가했다. 독립 quickstart는
  npm 패키지를 설치해 discover → freeze → replay를 실행하며, CI는 현재 빌드의 tarball로 이를 검증한다.
- **결정:** `describeAction`·`provesAnAction`·`hasSemanticCriterion`·`droppedProofReason`을 공개한다.
  경고 문구는 CLI와 Markdown 리포터가 각자 비공개로 구성하며 기존 출력과 판정은 유지한다.
- **검증:** 타입 검사·빌드·925개 테스트와 Node 20의 npm/pnpm 외부 설치 검증을 통과했다.
  실제 Chrome과 고정 LLM 응답으로 발견·저장·반복 재생을 확인했고, 재생의 LLM 호출은 0회였다.
  POST 500 뒤 완료 화면에 도착해도 실패로 판정하며, 잘못된 파일 입력과 자원 정리도 확인했다.
- **상태 변화:** #8의 공개 경계와 실행 가능한 소비자 예제를 마련했다. 기존 패키지 이름,
  browser entry, CLI 명령은 유지하며 실제 모델을 사용하는 discovery는 실행 안내만 제공한다.
