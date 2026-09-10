# PR221 — 실제 MCP 검증 버전 정렬과 캡처 준비 상태 재현

- 브랜치: `codex/198-perception-design`
- 버전 정렬 커밋: `09a6be5`
- 리뷰: https://github.com/team-poem/cairn/pull/221#issuecomment-5614579332
- 답글: https://github.com/team-poem/cairn/pull/221#issuecomment-5617649971

## 완료한 버전 정렬

`bench/local/cli.mjs`와 `examples/quickstart/quickstart.agentic.ts`의 실행 인자를 제품 기본값과 같은 MCP `1.8.0`, `--isolated`, `--no-page-id-routing`으로 맞추고, headless 설정을 유지했다. 이전 npm/pnpm 소비자 CI는 퀵스타트의 `~1.3.0` override를 실행했다. 별도의 로컬 1.8 실측은 있었으나, 기존 browser suite의 직접 Playwright 실행이나 SDK mock을 실제 1.8 통합 검증으로 볼 수 없다.

기존 전체 테스트 engine 1,157개와 root 69개, npm tarball 소비자 검증을 통과했다. 원격 `09a6be5`에서도 verify, probe-fixtures, npm/pnpm package-consumer와 PR triage가 모두 통과했다(CI run `34469657834`). 이 커밋은 테스트나 fixture 동작을 변경하지 않는다.

## 실제 MCP 재현

엔진 소스 SHA256 `ea6de089d1a431f53f5ce3b63736bd8f41b7125b2c6923cce610ba020223e1ae`를 그대로 실행했다. 공식 MCP 1.8의 스크립트 후 대기를 생략하면 150/180ms 뒤에 삽입되는 두 Save 버튼 대신 Loading 상태를 캡처했다. 각 지연 3회씩 동일했다.

guard 호출만 ordinary로 되돌린 실험과 모든 관찰 호출을 ordinary로 되돌린 실험은 버튼을 보았지만, guard 설치 후 대기 중 쌓인 삽입 기록 때문에 `locateRef`가 거부됐다. 단순한 대기 복원만으로 새로 삽입된 대상의 ref가 사용 가능해지지는 않았다.

다음 후보는 **ordinary 준비 대기 → 기존 fast guard 설치 → 캡처** 순서다. 임시 caller wrapper로 ordinary 평가 한 번을 추가했다. fixture 전용 함수는 타이머 시작 시점을 첫 평가에 맞추며, 제품 guard 스크립트나 MCP 내부를 수정하지 않는다. 이 후보는 아직 제품 구현이 아니다.

180ms 지연에서 두 번째 버튼의 캡처·nth 1 변환·실제 클릭은 3/3 성공했다. 250ms의 더 늦은 삽입은 준비 대기 이후 guard 설치 구간에 걸려 ref를 계속 거부했다. MCP의 제한된 quiet-window는 임의 앱의 준비 완료를 보장하지 않는다.

## 전체 탐색의 비용 비교

실제 `discover`와 기존 settle/observe/finish 경로를 실행하고, 현재 프롬프트에 반응하는 결정적 모델 구현을 사용했다. 실제 LLM이나 유료 호출은 없었다. 각 조건 3회이며, 모두 올바른 두 번째 버튼을 클릭하고 탐색을 완료했다.

| 페이지 | 현재 fast 중앙값 / 모델 요청 | 준비 대기 후보 중앙값 / 모델 요청 |
| --- | ---: | ---: |
| 준비된 페이지 | 5.018초 / 3회 | 5.429초 / 3회 |
| 150ms 지연 렌더링 | 6.236초 / 4회 | 5.483초 / 3회 |

정적 페이지에서는 약 0.41초 증가했고, 지연 사례에서는 재시도를 줄여 약 0.75초 감소했다. 지연된 fast 경로는 추가 `waitFor` 단계를 동결했다. 요청 수에는 결정과 마지막 단언 제안을 포함한다. 준비된 페이지의 단일 capture→click 속도 개선만으로 실제 탐색의 순이익을 단정할 수 없음을 보여주는 작은 표본이다. 생산 환경 성능이나 실제 모델 품질·비용의 증명이 아니다.

두 지연 경로의 동결 결과를 JSON으로 왕복시킨 뒤 별도 새 드라이버와 실제 BuiltinStepHandler로 재생했다. 모두 두 번째 버튼을 클릭했으며 모델 호출은 0회였다. 저장된 ref/handle은 없었다.

## 다음 구현과 검토 범위

새 API 회귀와 최소 순서 회귀 2개를 공식 `probe.sh`로 각각 RED 확인했다. 새 파일은 `chrome-observation-readiness.test.ts`로 계획했다. 기존 capability 회귀의 호출 개수·순서·인덱스 기대값 9줄을 정확히 바꾸는 안도 준비했다. 다섯 기존 관찰 검증, UID, 미지원 서버, 실패 시 인자만 바꿔 재시도하지 않는 규칙은 유지한다.

로컬 `failed-test.md`에는 기존 완료 57개 뒤에 검토 대기 2개를 추가했다. 기존 테스트나 계획 원문의 9줄은 아직 변경하지 않았다. 승인 후 새 원문과 정확한 예외를 적용하고, 실제 구현 소스로 다시 측정하고 정식 gate를 확인한다. `spec/core/perception.md`의 설명도 UI 쓰기 여부가 아니라 캡처 준비 상태와 유한 대기의 한계를 기준으로 고칠 예정이다.

원래 gate 기준 `1920886`과 기존 승인 5줄은 유지한다. `spec.md`와 develop 전용 `state.md`, workspace 하네스는 변경하지 않는다. PR은 아직 캡처 준비 상태 후속이 남았으며 merge/release 완료가 아니다.

로컬 검토안: `/tmp/cairn221-phase5-review.md`, 구현 초안 `/tmp/cairn221-phase5-candidate.patch`. 실험과 원시 결과: `/tmp/cairn221-phase5-readiness-report.md`, `...-readiness-results.json`, `...-preguard-results.json`, `...-discover-results.json`, `...-replay-results.json`.

## 회고

- Brain: 변경 없음. workspace 소유권 예외를 확대하지 않는다.
- Skills: 변경 없음.
- Structural: 저장소의 실제 소비자 CI 실행 버전을 제품과 정렬했다. readiness 순서 회귀 2개는 검토 대기다.
- Todos: 새 workspace 항목 없음. 이번 PR 후속은 로컬 계획과 이 기록에 남겼다.
