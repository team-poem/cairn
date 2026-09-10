# PR221 — 준비 대기 구현과 실제 소스 검증

- 코드 커밋: `108a570`, `9d2e49e`
- 측정 코드: `9d2e49e108bad78d00b98cd6b8b01e431914b78c`
- Chrome 소스 SHA256: `59b785b045b08ffd67439ed5ef06ab9a3013582955209a8dabba72d2a9a916ae`

## 구현 및 승인 범위

사용자가 이전 기록의 새 회귀 2개와 기존 capability 테스트 9줄 변경을 승인했다. 첫 API 테스트를 suite에 원문으로 넣어 Loading 캡처로 RED를 확인했다. 지원 서버의 perception 캡처에서 ordinary 준비 평가를 먼저 완료한 뒤 fast guard를 설치하도록 수정해 GREEN으로 만들었다. 최소 순서 회귀를 원문으로 추가한 뒤에도 전체 suite가 통과했다.

기능 협상과 기존 다섯 관찰 검증 경계는 유지한다. 추가 평가는 목적 태그 없이 호출하므로 준비 대기가 재귀적으로 반복되지 않는다. 미지원 서버와 일반 snapshot/replay는 이전 호출 순서를 유지한다. 캡처 이후 mutation을 지우거나 guard를 약화하지 않는다. `spec/core/perception.md`는 유한 DOM quiet-window와 준비 상태의 한계를 설명하도록 고쳤다.

기존 9줄 예외는 호출 개수·순서·인덱스에 한정했고, 로컬 계획의 대응 본문에도 동일하게 적용했다. header/helper/fixture와 다른 기존 테스트는 변경하지 않았다. 독립 검토에서도 정확한 예외, 새 header와 2개 본문, 실패 전파와 기존 경계 보존을 확인했다.

## 로컬 gate와 검증

- engine 1,159개 + root 69개 테스트 PASS.
- 기존 Chrome browser suite 21개 PASS. 이 suite는 직접 Playwright/가짜 MCP 경로를 포함하므로 아래 실제 MCP 검증과 구분한다.
- 타입 검사, 빌드, 의존성 경계 검사 PASS.
- 원래 기준 `1920886`과 기존 승인 5줄을 사용하는 **정식 gate PASS**: 계획 59개 모두 체크, 실제 본문 59개 검증.
- 추가로 수정 직전 `fcfb4d9`와 승인 9줄 자료를 사용해 같은 gate validator로 기존 테스트 보존 및 계획 59개를 검증했다. 이 검사는 원래 기준을 대체하지 않는다.

## 실제 수정 소스의 최종 측정

공식 MCP 1.8.0, 소스의 기본 실행 인자에서 headless와 계측용 설정만 추가했다. 모든 MCP 인자·목적 태그·반환값·오류를 그대로 전달하며 readiness나 wait 옵션을 계측기가 대신 주입하지 않았다. 다른 로컬 CPU 작업을 멈춘 뒤 경로별 warmup 2회, 측정 12회를 교차 실행했다. 측정 60건 모두 의도한 DOM 대상을 클릭했다.

| 경로 | 호출 수 | 중앙값 / 표본 p95(ms) |
| --- | ---: | ---: |
| 변경 없는 ref | 14 | 976.7 / 993.6 |
| enrichment 전 무관한 변경 | 16 | 1,087.2 / 1,091.8 |
| dispatch 전 무관한 변경 | 16 | 1,087.5 / 1,104.2 |
| compact 중 무관한 변경 | 16 | 1,086.6 / 1,105.0 |
| 기본 legacy 선택 | 4 | 445.4 / 456.6 |

같은 공식 MCP의 과거 일반 대기 표본 중앙값 1,284.5ms(n3) 대비 약 24% 감소했다. 준비 대기를 포함한 수치이며, 이전 763.6ms를 최종 성능으로 사용하지 않는다. 이번 비교는 base/head를 같은 실행에서 교차한 비교가 아니다. 표본 12개의 nearest-rank p95는 최댓값이고 production SLO가 아니다.

전체 행위 비용은 capture·locate·dispatch의 겹치지 않는 단계 시간을 합산한다. outer guard 호출 시간에는 내부 준비 호출이 포함되므로 개별 호출 시간을 합하면 중복된다. navigation/startup/검증/모델/network settle/인위적 drift 주입은 표의 시간에서 제외한다.

## 실제 준비 상태와 재생

실제 `discover`와 기본 settle/observe/finish를 실행했다. 모델은 실제 목록과 ref에 반응하는 결정적 구현이며 유료/실제 LLM을 호출하지 않았다. 준비된 페이지와 150ms 지연 렌더링에서 각각 3/3 완료, 모델 요청 3회, wire 호출 48회였다. 중앙값은 각각 5.458초와 5.505초였다. 모두 두 번째 버튼의 click 단계 하나를 만들었다.

최종 fixture는 첫 실제 capture 평가에 맞춰 일회성 EventSource로 타이머를 시작한다. 제품의 ordinary 준비 평가는 그대로 실행된다. 이전 wrapper 실험과 fixture 동기화 방법이 다르므로 탐색 시간의 차이를 정밀한 head-to-head 성능 개선으로 주장하지 않는다.

180ms 지연 삽입은 두 번째 버튼의 실제 클릭까지 3/3 통과했다. 250ms 늦은 삽입은 여전히 cohort 변경으로 3/3 거부했다. 캡처 후 선택 노드 교체도 클릭 없이 거부했다. 정적·지연 두 경로의 동결 결과를 JSON 왕복시켜 별도 새 드라이버의 BuiltinStepHandler로 재생했으며 동일한 버튼을 클릭하고 모델 호출은 0회였다. 이 fixture에서는 트래픽 없는 건강 단언이 vacuous이므로, 전체 critic 판정의 증명으로 확대하지 않는다.

실제 구형 MCP 1.3.0에서도 캡처 4회·전체 13회·ordinary 평가 5회, wait 옵션 및 추가 준비 평가 0회로 기존 경로와 정확한 두 번째 클릭을 확인했다. 이전 phase4의 select/navigation/dialog/frame 검증은 이전 소스의 증거로 보존한다.

## CI 및 실험 중 실패 기록

코드 `9d2e49e`의 원격 verify, probe-fixtures, npm 소비자는 통과했다. pnpm 소비자는 최초 `navigate_page`의 30초 timeout으로 두 차례 실패했다(run `34485138808`, attempts 1–2). 모두 새 readiness 전에 발생했다. 현재 로그는 Chrome 지연 초기화와 실제 navigation 중 어느 경계에서 멈췄는지 구분하지 못한다. 제품 timeout이나 테스트 기대값을 바꾸지 않고 추가 진단 중이다. 앞선 버전 정렬 `09a6be5`의 실제 MCP 1.8 pnpm CI는 통과했었다.

임시 측정 fixture에서도 탐색 6회 성공 뒤 다음 setup evaluation에서 navigation-context 오류가 한 번 발생했다. 일회성 SSE를 사용 후 닫도록 fixture를 정리하고 재실행한 검증은 통과했다. 최초 로그는 보존했으며 SSE가 원인이라고 단정하지 않는다. 실패 표본을 성공 측정에 섞지 않았다.

## 상태 변화

승인된 readiness 구현·59개 계획·로컬 gate·실제 MCP 동작/성능 검증을 완료했다. 원격 pnpm 초기 navigation 실패의 확인은 남아 있다. 전체 PR 완료나 merge/release 완료로 선언하지 않는다. 기존 저널과 develop 전용 state.md는 수정하지 않았다.

증거: `/tmp/cairn221-phase5-native-gate.log`, `...-exact-nine-audit.log`, `...-final-code-review.md`, `...-final-measure-report.md`, `...-production-results.json`, `...-final-readiness-results.json`, `...-old-server-results.json`, `...-pnpm-diagnosis.md`.
