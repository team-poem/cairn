# #230 — self-heal 실측 (GPT-5.6 Sol · Terra · Luna)

세 모델 모두 실제 UI 변경을 **1호출로 복구**하고, 저장한 복구본의 다음 두 실행을 **LLM 0회**로
통과했다. 본 측정 36/36 성공, 실제 복구 시도 3/3 성공이다. 한 로컬 픽스처의 버튼 → 링크 변경을
측정했으며 일반적인 self-heal 성공률이나 모델 품질 순위를 뜻하지 않는다.

## 조건과 출처

- 공통 소스: `45adbb87b1507c1569771f2af1cb0891fc8d3cc4`, 세 측정 모두 `dirty: false`.
  [Claude 측정](230-claude.md)과 같은 커밋이다. 결과 정리는 Claude 자료 커밋
  `db3a96ab74a93e09947d1033869a19ba1b88d4f7` 뒤에 추가했다.
- 엔진 빌드 SHA-256: `034a7e7131559cef2fdf52fd80f4b88ccbdc06334caf2ec2f3a0c9fd65232c47`.
  Claude와 #228 측정의 빌드와 동일하며 엔진 코드는 수정하지 않았다.
- Codex CLI `0.146.0`, Node `v26.5.1`, Chrome `153.0.8010.36`, Chrome DevTools MCP `1.8.0`.
- 설정: `bench/local/heal.gpt-5.6-{sol,terra,luna}.json` 그대로. 각 모델 `medium`,
  160호출 상한, tier `stateful`, arms `agent`·`cairn`, 6회씩 총 12시도.
- 버전 일정: `v1, v1, v1, v3, v3, v3`. 문서 지연 `[0,20]`ms, API 지연 `[0,40]`ms,
  `maxSteps: 20`. 목표는 로그인 → 책 한 권을 장바구니에 추가 → 주문이다.
- v3는 장바구니의 `Place order` 버튼을 같은 이름의 링크로 바꾼다. `/api/order` POST와
  `/done` 완료 조건은 유지한다. 기존 v1/v2 벤치 및 #228 결과는 별도 측정으로 보존했다.
- 2026-09-11 UTC: Sol 09:04:22–09:11:13, Terra 09:04:26–09:10:46,
  Luna 09:04:31–09:10:48. 세 모델을 동시에 실행했으며 각 시도는 별도 서버·브라우저·상태를
  사용한다. 경과 시간으로 모델 속도를 비교하지 않는다.
- GPT 파일럿·자동 재시도·중단·제외한 실행은 없다. 본 측정과 별도인 heal 비활성 대조 실행은
  모델당 v1·v3 각 1회, 총 6회다. v3의 의도된 실패 3건을 본 측정 성공률에 섞지 않는다.

## 결과

토큰은 관측된 일반 입력·캐시 읽기·캐시 쓰기·출력의 합이다. 모든 본 측정 기록의
`usageComplete`와 요약의 `tokensComplete`가 참이다. 캐시 토큰은 일반 입력에서 이미 분리돼 있고
추론 토큰은 출력에 포함되므로 다시 더하지 않는다. 호출 수는 벤치의 LLM completion 호출 수다.

| 모델 | 발견(1회차) | 복구(4회차) | 복구 후 재생(5·6회차) | cairn 6회 누적 | agent 6회 누적 |
| --- | ---: | ---: | ---: | ---: | ---: |
| GPT-5.6 Sol | 85,720토큰 · 7호출 | 11,417토큰 · 1호출 | 2/2 통과 · 0호출 | 97,137토큰 · 8호출 | 505,949토큰 · 42호출 |
| GPT-5.6 Terra | 83,988토큰 · 7호출 | 11,421토큰 · 1호출 | 2/2 통과 · 0호출 | 95,409토큰 · 8호출 | 506,453토큰 · 42호출 |
| GPT-5.6 Luna | 74,028토큰 · 7호출 | 9,994토큰 · 1호출 | 2/2 통과 · 0호출 | 84,022토큰 · 8호출 | 445,270토큰 · 42호출 |

세 모델 합계 150호출이며 모델별 50호출로 상한에 도달하지 않았다. Codex CLI는 달러 비용을
보고하지 않아 각 기록의 `costUsd`는 `null`이다. 요약의 누적 `costUsd: 0`은 알려진 비용의
빈 합이며 **무료라는 뜻이 아니다**(`costComplete: false`, `comparable: false`). 이번 자료는
달러 추정액이나 비용 교차점을 제시하지 않는다. Claude의 제공자 보고액과 토큰 수를 직접
비교해 가격·품질 순위를 만들지 않는다.

## 복구와 목표 달성 검증

1. cairn 1회차(v1)에 실제 모델이 발견한 원본을 저장했다. 2·3회차는 그 해시로 통과했고
   엔진·관측 호출 모두 0이었다.
2. 같은 원본을 heal 비활성 replay로 v1에 실행하면 통과, v3에 실행하면 세 모델 모두
   `step 6/6 blocked: no element matching {"text":"Place order","role":"button","index":0}`로
   실패했다. v3 대조 실행은 주문 0건, 엔진·관측 호출 0회였으며 종료 코드 1이 예상 결과다.
3. 본 측정 4회차(v3)는 원본 해시를 재생해 locator 복구 1회·LLM 1호출로 통과했다.
   저장된 복구본의 유일한 단계 변경은 마지막 클릭의 `role: button` → `role: link`다.
   원래 단계의 intent·expect와 시나리오 단언은 유지됐다.
4. 5·6회차는 4회차가 저장한 복구본 해시를 재생했고, 새 브라우저·초기화된 상태에서
   verdict 통과, `oracle.complete: true`, `orderCount: 1`, 엔진·관측 호출 모두 0을 확인했다.

| 모델 | 원본 SHA-256 | 복구본 SHA-256 (5·6회차 재생본) |
| --- | --- | --- |
| Sol | `92f9db92e9fffce4eb365fdd75eeb86df14f531a33ccc441e87afeefd45680b6` | `841cd267d3b9a70325036c66cc84e2bebfc6a5670582f0e15fd49848a98de8e0` |
| Terra | `ed9d0150e9e39ffcbb274c3dd51d7364a840da3c81281c73cafa44b82173b556` | `0962485a120f98caddfef73412dd70ec7934cea63c03f8736c0a8a6f9e43e248` |
| Luna | `bb26c6fb617c612a6c5ef22b24c6d3751ce711ba55f25e5c6843588455c21462` | `d12ad9f543bc61bf500f9df1d2d36e571c3fbc80bec12ba97e9f86de3d166697` |

세 모델 모두 얼린 단언은 `no-failed-requests`·`no-console-errors`·`navigated /done`이다.
`/api/order`의 `request-status` 단언은 없다. 주문 성공은 verdict와 별개로 픽스처 오라클의
주문 1건으로 확인했다. `waitFor` 단계가 없으므로 `waitFor.text` 복구는 이번 측정에 포함되지
않는다. 또한 agent의 발견 성공은 replayable scenario와 오라클 완료를 요구하고, cairn의
재생 성공은 얼린 단언도 요구하므로 두 방식의 성공 판정 절차는 동일하지 않다.

[Claude](230-claude.md)와 합친 본 측정은 60/60 성공, 실제 복구 5/5 성공,
복구 후 재생 10/10 성공·LLM 0회다. 별도 Claude 파일럿은 이 분모에 포함하지 않는다.

## 근거 자료와 재생성

[`230-codex.json`](230-codex.json)은 원본 결과의 부분집합으로, 36개 본 측정 기록과 6개 대조
기록, 실행 환경·설정, 엔진·관측 호출 수, capture 단계·단언·해시, 원본 파일의 SHA-256을
보존한다. 절대 경로·스택·중복 ledger는 제외한다. Claude JSON도 같은 정제기로 원본에서
재생성해 엔진 호출 수와 단언을 보강했으며 기존 측정값은 그대로다.

원본은 ignored `bench/results/heal-{sol,terra,luna}-1/` 및 각
`-replay-v1/`·`-replay-v3/`에 보존한다. 새 모델 호출 없이 표를 재생성한다.

```sh
node docs/benchmarks/230-evidence.mjs table docs/benchmarks/230-codex.json
```

## 재실행

공통 소스 커밋의 깨끗한 체크아웃에서 실행하고, 출력 디렉터리는 새 경로를 사용한다.
실측은 한 번 빌드한 뒤 아래 npm 명령이 호출하는 `node bench/local/cli.mjs`를 모델별로
동시에 실행했다. 아래 명령은 같은 설정으로 빌드부터 재현한다.

```sh
ENGINE_COMMIT=$(git rev-parse HEAD) # 45adbb87b1507c1569771f2af1cb0891fc8d3cc4
npm run bench:local -- cost --config bench/local/heal.gpt-5.6-sol.json --runs 6 \
  --engine-commit "$ENGINE_COMMIT" --out bench/results/heal-sol-new
npm run bench:local -- replay --config bench/local/heal-replay.v1.json --runs 1 \
  --engine-commit "$ENGINE_COMMIT" --captures bench/results/heal-sol-new/captures \
  --out bench/results/heal-sol-new-replay-v1
npm run bench:local -- replay --config bench/local/heal-replay.v3.json --runs 1 \
  --engine-commit "$ENGINE_COMMIT" --captures bench/results/heal-sol-new/captures \
  --out bench/results/heal-sol-new-replay-v3
```

Terra·Luna는 설정과 출력 이름을 바꾼다. v3 replay는 종료 코드 1을 반환해야 정상이다.
결과 정리는 보강된 `230-evidence.mjs`가 있는 커밋에서 실행한다. `distill`은 원본 디렉터리를
읽기만 하며 측정 소스 커밋을 바꾸지 않는다.

```sh
node docs/benchmarks/230-evidence.mjs distill out.json \
  sol=bench/results/heal-sol-new \
  sol-replay-v1=bench/results/heal-sol-new-replay-v1 \
  sol-replay-v3=bench/results/heal-sol-new-replay-v3
```
