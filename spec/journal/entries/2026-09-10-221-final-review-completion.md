# 2026-09-10 — PR #221 마지막 리뷰 수정 완료와 성능 잔여 조건

- 브랜치: `codex/198-perception-design`. 기능·계약 검증/재측정 기준: `ff1e6b0b8b4ff8fd8497f6a7d586a6f19df3281f`.
- 사용자 승인: 새 회귀17개와 기존 trace 버전3줄(제목1·기대값2)을 명시 승인받아 원문대로 수행했다. 이전30개를 포함한47/47 계획이 완료됐다.

## 최종 동작

1. select 재시도는 대기 뒤 compact 비교 기준을 갱신하고 verbose를 마지막에 캡처한다. 새 native Medium을 제외하고 custom Medium을 선택한다. 최초 구현에서 일반 클릭의 호출 수도 늘어난 것을 기존 테스트가 잡았고, 추가 compact를 select에만 한정했다. 일반 action/ref 경로의 비용·기존 재시도 계약은 유지했다.
2. 공통 선택 함수가 eligible 후보의 cap 누락 수를 함께 반환한다. 목록/ref표가 같은 결과를 쓰고 occlusion/region 중복/quota 제외를 잘림으로 세지 않는다. quota 밖의 intent evidence는 포함하며 입력·순번·기존 rankElements API를 보존한다.
3. 관측 거부와 JSON 파싱 이후 ref 거부를 별도 gate로 기록한다. 제한된 재관측, heal phase/case 연결, sink 실패 격리, 원시 응답값 비노출을 유지한다. explore의 optional trace는 이 두 진단과 마지막 관측만 다룬다. trace1.6은 gate2종·phase1종을 추가하며 envelope를 유지한다.
4. locator 프롬프트에서 실행 action/reason 규칙을 제거하고 name/ref/null 스키마만 안내한다. 기존 시스템 설명 문구 계약도 유지한다.

## 검증과 검토

- 새17개 모두 의도한 실패를 관측한 뒤 순차적으로 suite에 추가했다. 공통 수정으로 이미 GREEN인 후속 경계는 코드 변경 없이 그대로 추가했다. 단계별 full suite 실행과 기능 단위 타입 검사를 수행했다.
- 마지막 전체 suite: 엔진1147·루트69 통과. 실제 Chrome21 통과. typecheck/build/check:boundaries 통과.
- 실제 MCP1.3.0 select 재현: 수정 전 opener만 클릭하고 timeout, 수정 후 control2_1→custom option4_1 클릭·DOM selected=custom. compact3회+verbose1회가 기록됐다. 실제 UID-retirement 확인과 mapping-faithful 회귀는 verbose-only control을 compact 재캡처 뒤 잘못된 UID로 dispatch하지 않도록 검증한다.
- 독립 검토: cache/omission, diagnostics, locator prompt/parser의 정상 스키마에 차단 결함 없음. 기존 trace의 'explore phase 없음' 설명도 현재의 제한된 진단 범위로 갱신했다.
- `/tmp/cairn221-phase3-audit.py`: 기존test/support85파일은 승인한 버전3줄만 변경,47/47 계획 header/case가 원문과 일치.
- 원래 gate도 실행했다. 전체 suite는 통과하나 승인된3줄을 수정으로 보고 exit1이다. 하네스를 바꾸거나 통과로 표현하지 않는다. git-excluded 계획은 commit diff에 없어0this-run으로 보인다.

## 최종 예산·지연 재측정과 릴리즈 판단

실제 LLM 호출0. 예산56조합·정상재생·1/5/6복구·두레이어조합 결과는 수정 전과 같다. default5는 각 레이어의 요청 cap이다. 반복재사용 수율은 전부성공5·첫실패4·실패부터교대2·영구실패0이지만, 단일재생은 첫 미복구 단계에서 중단한다. cap을10/20으로 올려도 그 단계를 자동재시도하지 않는다. 정상재생0요청, 두레이어를 모두 사용하면5+5=10요청까지 가능하다. 기본5를 유지하고 범위를 명시했다.

MCP1.3.0·격리 로컬 Chrome, 경로별 warmup2회+측정12회. 7경로84회와 기본옵션2경로24회를 다시 실행했다. 표본12개의 nearest-rank p95는 최댓값이다.

| 최종 경로 | MCP 호출 | p50/p95 |
|---|---:|---:|
| 기본옵션 unchanged ref capture→enrich→click | 13 | 1250/1263 ms |
| 기본옵션 legacy capture→enrich→click | 4 | 415/420 ms |
| unrelated mutation ref (promotion off) | 15 | 1465/1476 ms |

시작/이동·settle·LLM·검증호출·인위적변경주입은 비용에서 제외했다. 변경중compact 경로의 주입시간은 total에서 제외하되 단계원시값에는 포함됨을 보고서에 명시했다. 새 retry-select 경로만 추가 compact가 생기며, 위 ref/일반legacy 호출 수는 그대로다.

**성능 릴리즈 조건은 열려 있다.** evaluate_script마다 MCP가 약200ms post-action wait를 붙이는 것이 주요 비용이다. list_pages는 약1ms라 단순 호출 제거가 해결책이 아니며, 서로 다른 비동기 경계를 보호하는 guard를 생략하지 않았다. 현재 비용을 소비자가 수용하거나 안전한 읽기 평가 최적화를 검증해야 성능 항목을 닫을 수 있다. 재생/치유/탐색 전체의 production latency나 실제 모델 성공률은 이 수치로 주장하지 않는다.

## 산출물·state 변화

`/tmp/cairn221-phase3-final-{budget,mcp,mcp-defaults}-results.json`에 원시 결과와 source HEAD가 있다. 같은 prefix의 스크립트·로그 및 final-measure-report.md에 재현 명령이 있다. 소스 이후 추가 변경은 검증 결과를 적는 문서뿐이다. PR 본문에는 네 가지 수정·측정치·gate 예외와 열려 있는 성능 조건을 반영한다. phase1/2 기록과 이번재현 entry는 이력으로 유지하고 develop소유 state.md는 건드리지 않는다. PR merge·패키지 릴리즈는 하지 않았다.

## Reflect

- Brain: 루트 하네스 제한으로 변경 없음.
- Skills: 변경 없음.
- Structural: 최신 select watermark·cap 누락 메타데이터·trace gate·locator 응답 분리를 코드와17개 회귀로 고정했다.
- Todos: 루트 추가 없음. MCP 읽기 probe 비용의 릴리즈 판단/안전한 최적화는 남아 있다.
