# 패키지 경계

`cairn-engine`은 엔진과 `cairn` CLI를 한 npm 패키지로 배포한다. 공개 entry는
`cairn-engine`과 `cairn-engine/browser`이며, 기존 export·타입·bin 경로를 유지한다.
별도 패키지 분리나 설치 의존성 축소는 이 경계 검사의 범위가 아니다.

CLI는 소스 실행(`tsx src/cli.ts`)과 배포 실행(`dist/cli.js`)에서 같은 공개 Node entry를
사용하도록 `./index.js`만 통해 엔진을 소비한다. 인자 파서는 CLI 소유다. 엔진을
임베드할 때는 공개 entry를 import하고 내부 `src/`나 `dist/core/` 경로는 사용하지 않는다.

`npm run check:boundaries`는 TypeScript parser로 모든 소스의 정적 import, type import,
재수출, 동적 import, 직접 `require()` 및 TypeScript `import = require()`를 검사한다.
문자열·주석 안의 예제 코드는 의존성이 아니다. 계산된 모듈 경로는 정적으로 검사할 수
없으므로 거부한다. 실제 소스에서는 tsconfig의 module resolution을 적용한다.
패키지의 `#imports` 별칭이 `dist/*.d.ts`로 해석되어도 같은 패키지의 내부 파일로
분류하므로, 별칭을 통한 내부 모듈 접근이나 CLI 역참조도 거부한다.

- CLI는 공개 entry와 CLI 모듈에만 접근한다. Node builtin과 CLI의 외부 의존성은 허용한다.
- `core/`는 다른 core 모듈에만 의존한다. 버전 조회(`version.ts`)는 Node 조립 계층 소유다. adapter·CLI·run·suite·
  공개 barrel·외부 패키지·Node builtin을 직접 import하지 않는다.
- 엔진은 CLI를 import하지 않는다. adapter는 core의 포트를 구현하며, reporter의 기존
  suite 결과 타입 참조는 유지한다.
- harness는 QA 앱에 의존하지 않는다. `packages/qa` 경로 및 `@cairn/qa`, `cairn-qa`와
  그 하위 경로를 거부한다. 새 QA 패키지 이름을 도입하면 검사 규칙도 함께 갱신한다.

이 검사는 직접 의존 방향을 고정한다. 브라우저 호환성과 배포 파일의 완전성은 별도의
브라우저 번들·tarball 소비자 검증으로 확인한다.

## 추가된 Node 진단 API

CLI가 사용하던 다음 함수를 공개 Node entry에서 재수출한다. 기존 구현을 그대로
공유하므로 판정 로직을 CLI에 복제하지 않는다. browser entry의 계약은 변경하지 않는다.

| 함수 | 소유권·사용 계약 |
| --- | --- |
| `describeAction(decision)` | discovery가 소유하는 `Decision`의 사람이 읽는 짧은 설명. 임베더의 진행 로그에 사용한다. |
| `unprovenLabel(suiteVerdict)` | suite reporter가 소유하는 행위 미증명 경고 문자열. 경고가 없으면 빈 문자열이다. |
| `navigationEvidenceLabel(suiteVerdict)` | suite reporter가 소유하는 마지막 mutation 이전 목적지 관측 경고. 경고가 없으면 빈 문자열이다. |
| `provesAnAction(scenario)` | freeze가 소유하는 진단 술어. vacuous가 아닌 `request-status` 또는 `custom` 단언의 존재를 검사한다. 시나리오 성공 판정 자체는 아니다. |
| `hasSemanticCriterion(scenario)` | freeze에 vacuous가 아닌 `expect` 단언이 남아 있는지 확인한다. 기계적 증명과 구별한다. |
| `droppedProofReason(traceEvent)` | grounding gate가 `request-status` 단언을 버린 이유. 관련 이벤트가 아니거나 action JSON이 잘못되면 `undefined`다. |

함수명·타입·위 의미는 공개 API 계약이다. 표시 문자열은 사람이 읽는 진단이며 정확한
문구를 파싱하는 프로토콜은 아니다. 구조화된 처리는 `TraceEvent`, `Scenario`,
`SuiteVerdict` 필드를 사용한다. 이 함수들이 성공 여부나 freeze 보존 여부를 새로 결정하지는 않는다.
