# PR221 — 필터링된 후보의 별도 안내

- 브랜치: `codex/198-perception-design`
- 구현 및 회귀 커밋: `9e27129`부터 `73b6802`
- 리뷰: https://github.com/team-poem/cairn/pull/221#issuecomment-5620272231

## 문제와 변경

표시 제한으로 생략된 eligible 후보 수는 정확했지만, 가림·영역 중복 제거·승격 quota로 제외된 후보는 모델에게 안내되지 않았다. 따라서 일부 후보만 남은 목록을 전체 페이지 목록으로 해석할 수 있었다.

semantic listing과 비어 있지 않은 reference table이 공통 formatter로 두 수치를 따로 안내한다. 기존 cap 안내는 유지하고, 정책 필터링에는 목록이 완전한 페이지 목록이 아니라는 문구를 추가한다. 필터링 수는 consumer의 perceive 결과에서 선택 수와 cap 생략 수를 뺀 값이므로 raw 입력과 혼동하지 않는다. 보존된 intent evidence는 제외된 후보로 세지 않는다. 전부 필터링되면 semantic 안내만 남고, 빈 ref 표에 가짜 행을 만들지 않는다. 빈 입력의 출력은 그대로다.

랭킹, 원래 순번, 타겟 binding, Chrome/MCP 호출과 준비 대기는 변경하지 않았다. `spec/core/perception.md`에 이 출력 계약을 반영했다.

## 승인과 검증

사용자가 검토 자료의 새 회귀 5개와 기존 `emptyEligiblePoolHasNoHiddenRows` 기대 출력 한 줄 변경을 승인했다. 새 사례는 구현 전 각각 RED를 확인했고, 실제 suite에서도 첫 prompt 사례의 RED를 확인한 뒤 구현했다. 승인 원문을 한 개씩 추가하면서 전체 suite를 GREEN으로 유지했다. 다섯 본문과 공통 header의 정확한 일치도 별도 확인했다.

- 실제 discover/explore 모델 입력, 가림·영역·quota별 수치, cap과 필터링 혼합, intent evidence 보존, 전부 필터링된 캡처를 검증한다. 결정적인 LLM 대역을 사용하며 유료 실제 모델 평가는 추가하지 않는다.
- engine 1,164개 + root 69개 테스트 PASS.
- 타입 검사, 빌드, 의존성 경계 검사 PASS.
- 원래 기준 `1920886`의 정식 gate PASS: 승인된 기존 5줄 예외 유지, 계획 64개 모두 체크 및 본문 검증.
- 추가로 수정 직전 `cd88f76` 기준의 정확한 승인 한 줄만 허용하는 validator PASS. 원래 gate 기준을 대체하지 않는다.
- 별도 코드 검토에서 차단할 문제 없음. 선택 알고리즘과 binding이 그대로이며 zero cap과 빈 ref 처리를 확인했다.

기존 성능 측정은 `9d2e49e`의 unchanged-ref 중앙값 976.7ms를 유지한다. 이번 출력 문구 수정에서는 브라우저 성능을 재측정하지 않았으며, 최신 커밋을 측정한 값이라고 주장하지 않는다. 최종 원격 CI 결과는 PR 본문과 checks에 기록한다.

## State 변화

최신 리뷰가 지적한 필터링 안내 누락을 수정하고 로컬 승인 계획 64개를 완료했다. legacy compact/verbose ordinal 한계, 잘못된 capability를 광고하는 서버의 평가 증폭, 동시 최초 연결의 중복 subprocess, iframe에서의 보수적인 ref 제외는 리뷰에서 분리한 후속 사항으로 남는다. 이 변경에서 merge나 release를 수행하지 않는다.
