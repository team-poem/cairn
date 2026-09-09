# 2026-09-08 — PR #215와 #218 통합

- **브랜치:** `codex/171-replay-environment`; 충돌 정리는 별도 `codex/215-integrate-secrets` worktree에서 수행.
- **원인:** #218의 비밀값 주입과 #215의 실행 환경 매칭 옵션이 CLI 파서·실행 옵션·기본 핸들러 생성자에서 겹쳐 5개 파일에 충돌.
- **해결:** develop `1ffc2a1`을 병합하며 두 옵션을 모두 보존. 이미 develop에 있는 `BuiltinStepHandler(secrets)`와 `defaultStepHandlers(actions, secrets)` 인자 순서를 유지하고 환경 매칭 옵션을 마지막 인자로 추가. 파이프라인은 시나리오의 wildcard와 요청 매칭 옵션이 준비된 뒤 두 옵션을 함께 전달.
- **계약:** 비밀값의 origin은 실행 환경 전환으로 변경하거나 확장하지 않는다. 실제 대상 URL에서 검사하며 원본 환경용 자격증명은 대상 환경에서 거부한다. 라이브러리·suite·CLI 모두 동일하며 원본 스킬과 캐시를 다시 쓰지 않는다.
- **검증:** 전체 1,056개 테스트(53개 파일), typecheck·build·의존성 경계 검사 통과. 별도 결합 실행으로 대상 origin 비밀값 입력, 원본 origin 비밀값 거부, URL/request wait 매칭, 비밀값 누락 시 LLM 호출 없이 environment 실패, suite 캐시 무변경, CLI 환경/반복 secret 플래그 동시 파싱 확인. 기존 테스트 수정 없음.
- **상태 변화:** #215에서 #218 머지에 따른 충돌 해소. `state.md`는 작업 브랜치에서 변경하지 않는다.
