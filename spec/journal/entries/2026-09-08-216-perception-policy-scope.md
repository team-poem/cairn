# 2026-09-08 — PR #216 지각 정책 범위 축소

- **브랜치/기준:** `codex/198-perception-contract`, develop `868412e`.
- **결정:** 사용자가 검토 권고를 받아들여 PR을 기존 지각 정책의 순수 함수 추출과 랭킹 한도 수정으로
  축소하고 커밋·푸시를 승인했다. 관측 ref·DOM 사실·Driver 포트·탐색 루프·self-heal 확장과 그 47개 테스트는
  이번 diff에서 철회했다. 해당 구현과 이전 저널은 로컬 `codex/198-observation-identity-deferred`의
  `290b17e`에 보존했다. 이력 재작성 없이 후속 커밋으로 범위를 줄였다.
- **구조 변경 (`8a7f766`):** 기존 `rankElements`와 클릭 후보의 영역 중복 제거·40개 제한 계산을
  `core/perception.ts`로 옮겼다. 기존 prompt 경로의 import/re-export 호환을 유지했다.
  Chrome DOM probe·캐시·`promoteClickables: false`·StaticText→button 동작은 그대로다.
  후보 계산은 기존의 첫 영역 대표 선택→40개 제한→이름 Set 순서를 보존한다. 공개 타입·포트는 늘리지 않았다.
- **동작 수정 (`cfb6894`):** 승인된 `rankMatchingEvidenceZeroBudget` 코드를 그대로 추가했다.
  전체 테스트에서 기존 989개 통과·새 1개 실패를 확인한 뒤, 실제로 비운 자리 수만큼만 텍스트 근거를
  추가하도록 한 줄을 수정했다. 한도 0뿐 아니라 이미 근거가 들어 있는 목록에서도 전체 한도를 지킨다.

## 검증

| 검증 | 결과 | 로컬 근거 |
| --- | --- | --- |
| 구조 변경 후 `npm test`, `npm run typecheck` | 989개 통과, 타입 검사 통과 | `/tmp/cairn-216-structural.log` |
| 회귀 테스트 RED | 989개 통과, 승인된 1개 assertion 실패 | `/tmp/cairn-216-budget-red.log` |
| 최소 수정 후 `npm test`, `npm run typecheck` | 990개 통과, 타입 검사 통과 | `/tmp/cairn-216-budget-green.log` |
| `npm run build`, `npm run check:boundaries` | 통과 | `/tmp/cairn-216-final-matrix.log` |
| `npm run test:browser -w cairn-engine` | 실제 Chrome 7개 통과 | `/tmp/cairn-216-final-matrix.log` |
| 독립 랭킹 비교 10,000건 | 8,112건 기존과 동일, 기존 한도 초과 1,888건만 제한 내로 수정 | `/tmp/cairn-198-reduced-review.mjs` |
| 독립 클릭 후보 비교 10,000건 | 기존 계산과 동일, frozen 입력 비변경 | 같은 검토 스크립트 |

독립 검토는 모든 행이 텍스트 근거인 경우의 제한 0·1·5·60도 각각 그 이하로 유지됨을 확인했다.
기존 989개 테스트·fixture·helper는 기준 커밋과 동일하게 유지했다. 기존 추가 계획은
`/tmp/cairn-198-failed-test-deferred.md`에 보존하고 clone 전용 `failed-test.md`는 축소 범위로 갱신했다.

**state 변화:** PR #216은 공통 정책 추출과 기존 한도 초과 수정만 제공한다. #198의 포털 우선순위와
요소 정체성 설계는 여전히 후속 과제이며, 이 PR로 이슈 전체를 닫지 않는다. 독립 검토에서 추가 지적은
없었고 다음 단계는 부모 작업의 최종 gate와 푸시다. 인간 소유 `spec.md`, develop 전용 `state.md`,
루트 brain·skill은 변경하지 않았다.

**교훈:** 정책을 분리하는 작업과 관측·실행 계약을 확장하는 작업은 따로 검토 가능해야 한다.
범위를 줄일 때는 원본을 보존하고 최종 diff와 검증 근거를 새 범위에 맞춰 다시 작성한다.
