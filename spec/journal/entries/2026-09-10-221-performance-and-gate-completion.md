# PR221 — 관찰 성능 개선과 정식 gate 완료

- 브랜치: `codex/198-perception-design`
- 검증한 코드: `49896dda36721a7d02621c0ca028569b87871766`
- 이전 기록 `2026-09-10-221-observation-wait-validation.md`의 SDK timeout 후속은 아래 수정으로 완료했다. 과거 기록은 당시 상태로 보존한다.

## SDK timeout 후속

사용자가 추가 재현 테스트 2개를 승인했다. 첫 테스트를 실제 suite에 넣어 RED를 확인한 뒤, SDK의 `McpError`와 `ErrorCode.RequestTimeout`을 사용해 오류 코드를 판별하도록 수정했다. 기존 초기화 실패 경로가 transport를 닫고 `transport` 오류로 종료한다. 오류 문구가 달라도 같은 코드이면 실패하는 두 번째 테스트도 통과했다.

SDK 자체 제한 시간이 사용자의 더 긴 `timeoutMs`보다 먼저 만료되는 경우를 구형 서버로 오인하지 않는다. 일반적인 기능 미지원 fallback은 유지한다. 새 테스트는 승인된 원문 그대로 추가했고, 기존 header와 테스트는 변경하지 않았다.

## 정식 gate와 패키지 검증

- 전체 테스트: engine **1,157개** + root **69개** 통과.
- 로컬 계획 **57개**가 모두 체크됐고, 정식 gate가 각 테스트의 실제 본문을 확인했다.
- 기준 커밋은 `1920886` 그대로다. 승인 예외는 기존 trace 버전 3줄과 MCP 실행 버전·인자 테스트 2줄, 총 **5줄**이다. 그 외 기존 테스트 변경은 차단한다.
- `bash tdd-set/bin/gate.sh apps/cairn-198-design 1920886 --approvals /tmp/cairn221-phase4-final-gate-approvals.json` → **PASS**. 별도 감사나 기준 커밋 이동으로 대체하지 않았다.
- 최종 SDK 수정 후 타입 검사, 빌드, 의존성 경계 검사, npm tarball 소비자 검증이 통과했다. 소비자 검증은 공개 타입, 설치 CLI, browser bundle, 실제 Chrome quickstart를 포함한다.
- 앞선 동일한 관찰 구현에서 Chrome 21개와 pnpm 소비자도 통과했다. 이후 source 변경은 SDK 타입 import와 timeout 분류 한 줄뿐이다. GitHub CI도 코드 커밋 `49896dd`에서 npm·pnpm을 포함한 5개 검사를 모두 통과했다(run `34443005095`).
- 독립 검토에서 SDK timeout 누락 해결, 신규 10개 테스트와 header 원문 보존, 정확한 기존 5줄 예외, 5개 관찰 검증 경계와 실제 입력 대기 보존을 확인했다.

workspace 하네스 수정은 사용자에게 별도로 승인받은 root 커밋 `3a5ad7f`에 있다. 이번 앱 PR에는 하네스 파일이나 git-excluded 계획 파일을 넣지 않는다.

## 최종 구현 성능

SDK 수정까지 포함한 코드 `49896dd`로 실제 MCP 1.8.0을 실행했다. source SHA256은 `ea6de089d1a431f53f5ce3b63736bd8f41b7125b2c6923cce610ba020223e1ae`다. 기본 실행 인자에서 headless와 계측용 통계 비활성화만 추가한 격리 브라우저다. 계측기는 실제 인자·반환값·오류를 그대로 전달하고, `waitForStableDom`을 대신 주입하거나 MCP를 patch하지 않았다.

| 경로 | 호출 수 | 중앙값 / 표본 p95(ms) |
| --- | ---: | ---: |
| 변경 없는 ref | 13 | 763.6 / 780.0 |
| enrichment 전 무관한 변경 | 15 | 877.0 / 887.0 |
| dispatch 전 무관한 변경 | 15 | 868.8 / 889.1 |
| compact 중 무관한 변경 | 15 | 870.4 / 890.3 |
| 기본 legacy 선택 | 4 | 444.1 / 448.1 |

각 경로에서 warmup 2회 후 12회 측정했다. 측정 60개 액션 모두 의도한 DOM 대상을 확인했다. 표본 12개의 nearest-rank p95는 최댓값이며 production SLO가 아니다. startup, navigation, settle, LLM, 검증 호출과 인위적 변경 주입은 위 행위 비용에서 제외한다.

같은 MCP 1.8.0에서 기존 일반 대기 경로의 ref 중앙값은 1,284.5ms(n3)였다. 최종 구현은 약 40.6% 개선됐으며 13개 호출과 검증 경계는 유지했다. 관찰 이후 DOM 안정화 대기만 줄고 navigation 감지 대기는 남으므로, 처음 실험한 약 230ms를 배포 성능으로 주장하지 않는다. 사용자는 약 0.77초의 공식 옵션 방향을 승인했다.

기존 실제 1.8.0 및 사용자 지정 1.3.0의 동일성·변경 거부 matrix, native/custom select, navigation, 새 탭, confirm, iframe의 보수적 ref 생략 검증도 유지된다. 이후 SDK 변경이 해당 행위 경로를 바꾸지 않음을 diff로 확인했고, 위 최종 측정은 새 코드의 연결과 실제 dispatch까지 다시 실행했다.

## 상태 변화

PR221의 성능 구현과 SDK timeout 후속, 57개 정식 gate 검증은 완료됐다. 측정치를 PR 본문에 반영하고 원격 CI를 확인한다. GitHub 리뷰 승인은 메인테이너 절차이며, 이 작업에서 merge나 패키지 release는 하지 않는다. `state.md`는 develop에서 반영한다.

로컬 증거: `/tmp/cairn221-phase4-release-native-gate.log`, `...-release-production-results.json`, `...-final-measure-report.md`, `...-final-code-review.md`, `...-release-consumer-npm.log`. Brain과 skills는 변경하지 않았으며, 회고 결과는 이 저널과 검증 구조에 남겼다.
