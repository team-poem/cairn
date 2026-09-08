# 2026-09-08 — #198 공통 지각·관측 참조 구현과 검증

- **브랜치/기준:** `codex/198-perception-contract`, develop `868412e`. 런타임 검증 기준 커밋은 `182666f`.
- **승인과 진행:** 사용자가 검토한 47 RED 테스트의 구현·검증·draft PR 진행을 대화에서 승인했다.
  승인된 코드 블록을 그대로 새 테스트 파일에 추가하고 한 항목씩 Red→Green→Refactor를 진행했다.
  47개 모두 체크 완료했으며 기존 테스트·fixture·helper는 변경하지 않았다.
- **구현:** 공통 정규화·랭킹을 Node/browser에 공개하고 discover/explore가 같은 opt-in 관측 경로를 사용한다.
  source role과 원래 중복 순번을 유지한다. 결정의 ref를 현재 관측과 검증하고 정책 호출 전에 이름·역할을
  보완한다. 다섯 입력 동사는 정확한 관측 노드를 사용하며 만료·교체 시 동명 요소로 우회하지 않는다.
  freeze는 영속 Target 필드만 저장하고 SelfHealingDriver는 ref 오류를 자동 치유하지 않는다.
  Chrome은 인스턴스·관측 세대별 참조와 UID별 DOM 사실을 수집하며 기존 기본 snapshot 캐시·옵션을 유지한다.

## 검증 결과

| 명령/검증 | 결과 | 로컬 근거 |
| --- | --- | --- |
| 기준선 `npm test`, `npm run typecheck` | 989개 통과, 타입 검사 통과 | Phase 0 기록 |
| 최종 `npm test`, `npm run typecheck` | 45개 파일, 1,036개 통과, 타입 검사 통과 | `/tmp/cairn-198-policy-refactor.log` |
| `npm run build`, `npm run check:boundaries` | 통과 | `/tmp/cairn-198-final-matrix.log` |
| `npm run test:browser -w cairn-engine` | 실제 Chrome 7개 통과 | `/tmp/cairn-198-final-matrix.log` |
| `npm run test:consumer -- npm` | packed 소비자 타입·CLI·browser bundle·Chrome quickstart 통과 | `/tmp/cairn-198-consumer-npm.log` |
| `npm run test:consumer -- pnpm` | 동일 packed 소비자 검증 통과 | `/tmp/cairn-198-consumer-pnpm.log` |
| 초기 GREEN 3개 재-probe | `legacyDecisionUnchanged`, `rankEmptyLegacyBoundary`, `selfHealLegacyCapabilityAbsent` 모두 GREEN | `/tmp/cairn-198-phase0/` 코드와 실행 출력 |
| 별도 실제 Chrome dogfood | 동작 18개 통과 | `/tmp/cairn-198-browser/results.json` |

별도 브라우저 검증은 격리된 headless Chrome과 MCP 1.3.0에서 수행했다. 70개 배경 요소 뒤의 포털 옵션,
폐색, 클릭 영역 중복 제거, 관측 후 같은 노드의 재정렬, 교체 후 동명 폴백 거부, 관측·입력·페이지·인스턴스·
종료 시 참조 만료, 다섯 동사, 영속 Step 직렬화 후 새 페이지 재생을 확인했다. 최초 scratch select는 DOM
value `large`를 전달해 실패했으며 기존 MCP가 accessible label `Large`를 요구함을 확인했다. 입력을 고친
후 나머지 검증이 통과했으며 이 검증 실수로 제품 소스를 바꾸지는 않았다.

## 아직 해결하지 않은 항목

검토에서 아래 3개 결함을 재현하는 추가 6 RED 테스트가 나왔다. 별도 검토 worktree에서 초안을 준비해
사용자에게 제시했으나 아직 승인받지 않았으므로 이 구현에 테스트나 수정을 추가하지 않았다.

1. 폐색된 clickable 행이 영역·40개 우선순위 한도를 먼저 소비해 보이는 요소를 밀어낼 수 있다.
2. 이미 잘린 목록에 텍스트 근거가 있을 때 근거 삽입이 전체 listing 한도를 초과할 수 있다.
3. explore의 결과 비교에 일시적인 ref가 포함되어, 참조만 바뀐 무반응 동작을 UI 변화로 오인할 수 있다.

또한 이름 없는 roleless DOM 요소가 AX 스냅샷에 없으면 Chrome 관측에 새로 나타나지 않는 경계를 실제로
확인했다. custom Driver가 제공한 ref와 영속 selector의 테스트가 이 Chrome 수집 공백을 해결했다는 뜻은
아니다. framework 상태 추론이나 전체 DOM 자동 수집으로 범위를 넓히지 않았다.

## 인수인계와 배운 점

- 47개 승인 범위는 구현·검증 완료지만 #198 전체 완료를 선언하지 않는다. 다음 단계는 독립 최종 검토와
  `Refs #198`를 사용한 미완료 draft PR이다. 추가 6개 테스트 승인 후 남은 세 결함을 순서대로 해결한다.
- 일시적인 관측 식별자는 정확한 입력에 필요하지만 UI의 의미상 동일 여부를 판단하는 값으로 쓰면 안 된다.
  우선순위 한도는 실제로 표시 가능한 대표만 세고, 이미 포함된 근거를 삽입할 때도 전체 예산을 지켜야 한다.
- DOM 사실은 이름이 아닌 실제 UID에 결합해야 한다. 측정 실패·혼합 프레임·불확실한 폐색은 unknown으로
  유지하고, 기존 기본 경로의 캐시와 프롬프트 계약은 추가 opt-in 경로로 보존한다.
- 앱의 `failed-test.md`는 clone에서 제외된다. 인간 소유 `spec.md`, `spec/journal/state.md`, 루트 brain 및
  skill 파일은 변경하지 않았다. 이 작성자는 푸시·PR 생성 없이 부모 작업에 소유권을 넘긴다.
