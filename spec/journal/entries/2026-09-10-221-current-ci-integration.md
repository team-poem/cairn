# PR221 — develop의 새 CI 통합

필터링 안내 수정 `2abeb2f`의 CI를 기다리는 동안 #227이 develop에 병합됐다. 새 benchmark workflow는 candidate HEAD의 `bench/ci-compare.mjs`를 실행하지만 해당 파일이 이전 PR 브랜치에 없어 `MODULE_NOT_FOUND`로 실패했다.

develop `78a187a`를 `aa14363`에서 충돌 없이 병합해 이미 승인·병합된 benchmark와 운영체제 호환성 검증을 가져왔다. 이 통합에서 engine 소스나 기존 테스트를 수정하지 않았다. benchmark를 생략하거나 workflow를 약화하지 않았다.

통합 후 타입 검사·빌드·의존성 경계 검사가 통과했다. 정식 gate도 원래 `1920886` 기준으로 PASS: engine 1,164개 + root/benchmark 126개, 계획 64개 본문 검증, 기존 승인 예외 5줄 유지. `cd88f76` 기준의 추가 audit 역시 이번 승인 한 줄 외 기존 테스트 보존을 확인했다.

통합 전 CI의 pnpm consumer는 관찰 준비 단계에 도달하기 전 첫 `navigate_page`의 30초 시간초과로 실패했다. 이전에 기록한 증상과 같지만 근본 원인은 확정하지 않았다. npm consumer는 통과했다. 이번 통합에서 timeout, 재시도 정책, 테스트 기대값을 바꾸지 않았으며 최신 커밋의 원격 CI 결과는 PR에 별도로 기록한다.

State 변화: PR이 현재 develop의 CI 도구를 포함한다. 필터링 안내 구현과 기존 성능 측정 근거는 이전 기록 그대로이며, merge와 release는 수행하지 않는다.
