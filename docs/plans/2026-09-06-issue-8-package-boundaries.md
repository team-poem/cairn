# #8 분석과 CLI·패키지 경계 작업안

상태: 2026-09-06 사용자 승인 후 구현·통합·로컬 검증 완료.
실행 안내는 [독립 quickstart](../../examples/quickstart/README.md), 경계 규칙과 공개 진단 API는
[패키지 경계](../package-boundaries.md), 최종 결과는
[통합 기록](../../spec/journal/entries/2026-09-06-issue-8-integration.md)에 있다.

## 요청의 의미

- [이슈 #8](https://github.com/team-poem/cairn/issues/8)은 공개 패키지를 설치하고 `discover → freeze → replay`를 실행할 수 있는 독립 예제와 npm/pnpm 안내를 요구한다.
- [solp721의 마지막 댓글](https://github.com/team-poem/cairn/issues/8#issuecomment-5391125274)은 예제를 레포 재구조화 뒤로 미루고, 새 경계 위의 예제를 CI에서 실행해 임베딩 가능성을 증명하자는 순서를 제시한다.
- [Discussion #168](https://github.com/team-poem/cairn/discussions/168)은 별도 cli/core/adapters 패키지와 단일 패키지 내부 경계 강제를 모두 선택지로 둔다. 조회 당시 댓글은 없으며, 한 안으로 합의된 상태가 아니다.

따라서 첫 작업은 CLI와 라이브러리 사이의 의존 경계를 정의하고 검증하는 것이다. 예제를 추가하는 것만으로 선행 작업이 끝났다고 보기는 어렵다.

## 확인한 현재 상태

2026-09-06 조회 기준 로컬 HEAD는 `81493a3`, 원격 develop은 `94ee94ebdb2c64d9be1b16c4a22ee4f940538d2d`다. 원격이 11커밋 앞서 있다. 비교 결과 manifest·공개 index·browser entry·CI·기존 경계 테스트는 같고, CLI에는 #203의 navigation evidence 출력 등이 추가되어 있다. 구현은 최신 develop을 기준으로 해야 한다.

| 관찰 | 근거 |
| --- | --- |
| `cairn-engine` 한 패키지가 라이브러리와 `cairn` 명령을 함께 배포한다 | `packages/harness/package.json`의 `bin`, `exports` |
| 공개 entry는 `cairn-engine`, `cairn-engine/browser`다 | 같은 manifest의 `exports` |
| CLI가 core·adapters·run·suite 내부 파일을 직접 import한다 | `packages/harness/src/cli.ts:21` 이후 |
| 최신 CLI가 쓰는 내부 함수 중 6개는 공개 index에 없다 | `describeAction`, `unprovenLabel`, `navigationEvidenceLabel`, `droppedProofReason`, `hasSemanticCriterion`, `provesAnAction` |
| 브라우저 테스트는 정적 import 문자열의 상대경로만 추적한다 | `packages/harness/test/browser-entry.test.ts` |
| CI grep은 core 아래의 `node:` 문자열을 검사한다 | `.github/workflows/ci.yml` |
| CLI 테스트는 `tsx src/cli.ts`를 실행한다 | `packages/harness/test/cli.test.ts`; 배포 bin 검증과 다르다 |
| 배포 workflow는 harness의 버전과 단일 npm publish에 맞춰져 있다 | `.github/workflows/release.yml` |
| 독립 `examples/`는 없다 | 현재 체크아웃과 원격 변경 파일 목록 확인 |

현재 가드는 유용하지만 동적 import·외부 패키지의 전이 Node 의존·설치된 산출물의 누락까지 증명하지 않는다. 기존 browser entry가 이미 깨졌다는 뜻은 아니다.

## 추천: 기존 패키지 안에서 경계를 먼저 강제

`cairn-engine` 이름, 두 공개 entry의 기존 export 이름·타입 계약, `cairn` 명령과 기존 옵션·종료 코드를 유지한다. CLI는 엔진의 공개 표면을 소비하고, core는 포트·도메인에만 의존하며, adapters는 core 방향으로 의존하도록 검사한다. 엔진에서 CLI로 향하는 역참조와 `spec/architecture.md` 불변식 #6의 harness→qa 의존도 금지한다.

현재 6개 내부 함수를 전부 export하는 것은 해결책으로 확정하지 않는다. 출력용 함수는 출력 계층에서 공유할지, 엔진 소비자에게 유용한 진단 API로 제공할지 먼저 분류한다. freeze 증명 판정을 CLI에 복제하면 엔진과 판정이 갈라지므로 공통 판정의 소유권을 유지한다. 공개 API를 늘린다면 의미와 호환성 계약을 명시한다.

별도 npm 패키지 분리는 후속 선택지로 남긴다. 분리할 경우 이름·bin 이전·버전 동기화·릴리스 정책을 함께 결정해야 한다. 내부 경계안은 설치 의존성 자체를 줄이지 않으며, Node entry의 MCP 의존을 제거하는 작업도 포함하지 않는다.

## 단계별 산출물

1. **경계 강제:** CLI가 허용된 엔진 entry만 사용하게 정리하고 core→adapters/CLI, 엔진→CLI 역참조를 검사한다. 기존 소스 CLI 실행 경로와 테스트는 유지한다. 구조 변경과 동작/API 변경은 분리한다.
2. **배포 산출물 검증:** 빌드 후 `npm pack`한 tarball을 레포 밖 임시 소비자 디렉터리에 설치한다. 공개 import·타입 선언·설치된 bin을 검증하고 `cairn-engine/browser`를 실제 브라우저 대상으로 번들한다. Node builtins를 external 처리해 오류를 숨기지 않는다.
3. **독립 quickstart:** `examples/quickstart`에 자체 manifest, 로컬 웹 fixture, `*.agentic.ts` runner, 재생용 `*.skill.json`, npm/pnpm 설치·명령·예상 결과 안내를 둔다. 엔진 소스·테스트 helper·workspace 상대경로는 사용하지 않는다.
4. **예제 CI:** PR 빌드의 tarball을 설치해 같은 runner를 실행한다. 공개 API를 통한 discovery/freeze/replay와 성공·실패 종료 코드를 확인한다. 이것까지 통과해야 #8의 완료 조건을 충족한다.

사용자용 예제는 배포된 버전을 의존성으로 선언하고, CI만 현재 PR tarball로 교체한다. npm/pnpm 모두 독립 설치를 확인한다. CI에서 workspace symlink나 기존 `dist/`를 읽어 통과하는 우회를 허용하지 않는다.

CI의 discovery는 공개 LlmClient 포트에 scripted 응답을 주입하고 로컬 fixture를 대상으로 실제 드라이버를 실행한다. 실제 LLM discovery는 별도 문서 명령으로 안내하며 필요한 모델 인증·Chrome 조건을 명시한다. scripted discovery는 계약 배선을 검증할 뿐 실제 모델의 발견 품질을 증명하지 않는다.

## 실패 테스트 후보와 완료 기준

아래는 분석 당시의 요구사항 후보 목록이다. 구현 단계에서는 `failed-test.md`의 probe된
경계 테스트 9개와 독립 소비자 검증 스크립트로 구체화했다. 이미 존재하던 동작의 보존은
기존 suite·공개 표면 비교·설치된 CLI 검증으로 확인했다.

| 검증 대상 | 기대 결과 |
| --- | --- |
| CLI가 engine internal을 import하는 반례 | 경계 검사 실패; 공개 entry import는 허용 |
| core→adapter/CLI, engine→CLI 역참조, harness→qa | 경계 검사 실패; 정상 방향은 허용 |
| browser entry의 전이 Node builtin·Node 전용 외부 의존 | 실제 브라우저 번들 실패; 정상 entry는 성공 |
| tarball의 공개 import·타입 선언 | 레포 밖 소비자에서 import와 타입검사 성공 |
| 두 entry의 기존 export·타입 계약 | 변경 전 export와 소비자 타입 사용례 보존; 예제에서 쓰지 않는 API도 삭제·축소하지 않음 |
| 설치된 `cairn --version`, 잘못된 명령, 필수 인자 누락 | 기존 버전 출력·종료 코드 0/2/1 유지 |
| 독립 quickstart npm/pnpm 설치 | workspace나 엔진 소스 편집 없이 실행 가능 |
| discover → FileSkillStore freeze/load → replay | 같은 공개 API runner에서 round trip 성공 |
| frozen replay 반복 | 목표 단언 통과, discovery LLM 호출 추가 0 |
| fixture의 목표를 깨뜨린 replay | 실패 verdict와 exit 1; 성공처럼 출력하지 않음 |
| malformed/missing skill | 명확한 오류·비정상 종료, 브라우저 자원 정리 |

일반 완료 검증은 `npm run typecheck`, `npm run build`, `npm test`와 추가 경계·tarball·예제 CI다. 문서의 실제 LLM 명령 실행 여부는 별도로 기록한다.

## 승인받은 목표

> cairn-engine의 기존 npm 이름·공개 entry의 export 및 타입 계약·CLI 사용법을 유지하면서 CLI와 엔진의 내부 의존 경계를 자동 검사한다. 공개 표면만 사용하는 독립 quickstart에서 install → discover → freeze → replay를 실행하고, CI에서 현재 빌드의 npm tarball을 레포 밖에 설치해 성공과 실패를 검증한다. npm/pnpm 사용법과 예상 출력·종료 코드를 안내한다. 별도 npm 패키지 분리·스토리지 재설계·discover 휴리스틱 변경은 범위에서 제외한다.

사용자가 작업안 제시 후 “진행해줘”라고 지시하여 위 목표와 작업 범위를 승인했다.
`spec.md`는 수정하지 않았고, 승인된 작업안에 따라 로컬 `failed-test.md`를 구체화했다.

## 초기 분석의 확인 결과

- 로컬 `81493a3`에서 CLI·인자 파서·browser entry의 기존 테스트 3파일, 12개 통과.
- 처음 CLI 테스트 2개는 tsx IPC 소켓의 sandbox `EPERM`으로 실패했다. 소스 변경 없이 같은 명령을 정상 권한으로 재실행해 12개 통과를 확인했다.
- 전체 suite·빌드·타입체크·tarball 설치·새 예제는 이번 분석 단계에서 실행하지 않았다.
- 최신 원격 CLI import와 원격 변경 목록을 별도 확인했다. 원격 HEAD에서 테스트한 결과는 아니다.
- 구현·기존 테스트·spec 템플릿·기존 `reports/`는 변경하지 않았다.
