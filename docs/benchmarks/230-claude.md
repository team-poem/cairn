# #230 — self-heal 실측 (Claude Sonnet 5 · Opus 5)

기존 벤치의 v2 변경(라벨 이름 바꾸기)은 얼린 타겟의 역할·위치 fallback이 흡수해 self-heal이
한 번도 돌지 않았다(#170·#228 모두 복구 0회). 이 측정은 fallback으로 해결되지 않는 변경을
넣어, 실제 모델이 복구하는지와 **저장한 복구본의 다음 실행이 LLM 0회로 통과하는지**를 잰다.
한 픽스처의 한 변경에 대한 결과이며, 일반적인 self-heal 성공률이 아니다.

## 변경 설계 — 픽스처 v3

`stateful` 여정(로그인 → 장바구니 → 주문)의 장바구니 페이지에서 `Place order` 컨트롤을
`<button>`에서 `<a href="/done">`로 바꿨다. 이름·`/api/order` POST·`/done` 도착·완료 판정은
그대로이고, v2가 바꾸던 나머지 라벨은 v1 이름을 유지한다. 얼린 타겟
`{"text":"Place order","role":"button","index":0}`는 같은 역할 안에서 이름을 찾고, 없으면 역할과
위치로 물러나는데, 버튼이 하나도 없는 페이지에서는 둘 다 실패한다. v3는 `stateful` 이외
tier에는 존재하지 않는다(설정 검증이 거부한다). 구현: `bench/local/server.mjs`.

## 조건

- 소스: `45adbb87b1507c1569771f2af1cb0891fc8d3cc4`(브랜치 `feat/230-self-heal-bench`, 깨끗한 체크아웃,
  `dirty: false`). 엔진 빌드 SHA-256 `034a7e7131559cef2fdf52fd80f4b88ccbdc06334caf2ec2f3a0c9fd65232c47`
  — #228 측정과 같은 빌드다(벤치 코드만 바뀌었고 `packages/harness`는 그대로).
- 모델: `claude-sonnet-5`, `claude-opus-5`. Claude Code CLI `2.1.268`, Chrome `153.0.8010.36`,
  Node `v26.5.1`, Chrome DevTools MCP `1.8.0`(`--isolated --headless`).
- 설정: `bench/local/heal.claude-sonnet-5.json`(SHA-256 `e1d37594…8cd71c3`),
  `bench/local/heal.claude-opus-5.json`(`ebb16a78…a71303`). 여정 `stateful`만, 방식 `agent`(매번
  탐색)·`cairn`(한 번 탐색 후 재생, heal 활성), 버전 `v1, v1, v1, v3, v3, v3`, 문서 지연 `[0, 20]`ms,
  API 지연 `[0, 40]`ms, `maxSteps 20`. 상한은 기존 `cost.*.json`과 동일(Sonnet 400호출·$6,
  Opus 400호출·$12). 기존 v1/v2 픽스처·설정·결과는 바꾸지 않았다.
- 실행 일정(UTC, 2026-09-11): 파일럿 08:44:37–08:45:29. 본 측정은 Sonnet 08:45:53–08:50:40과
  Opus 08:45:58–08:50:10을 **동시에** 실행했다(시도마다 별도 서버·Chrome 프로필·상태). 경과 시간으로
  모델 속도를 비교하지 않는다. 무-heal 재생 검증은 Opus 08:50:36–08:50:46, Sonnet 08:50:56–08:51:06.
- 실패·예산 중단·재시도: 없음. 버린 실행도 없다. 본 측정 전에 스크립트 소스(LLM 없음)로 v3가
  fallback을 깨는지 확인한 연결 검증은 커밋 전 트리에서 돌렸으므로 근거 자료에 넣지 않았다.

## 검증 순서와 결과

각 단계는 cost 러너의 기록(`records[]`)과 별도 replay 실행으로 확인했다.

1. **실제 모델로 발견하고 freeze** — cairn 1회차(v1) 7호출. 얼린 단계: `Username` 입력,
   `Log in` 버튼, `Add to cart` 버튼, `Cart` 링크, `Place order` **버튼**. 두 모델 모두 같은 형상.
2. **변경 전 재생** — 2·3회차(v1) 통과, 엔진·관측 호출 모두 0. 별도로 같은 freeze를 LLM 금지
   replay 모드로 v1에 재생: 통과, 0호출.
3. **변경 후 heal 없이 실패** — 같은 freeze를 LLM 금지 replay 모드로 v3에 재생: 두 모델 모두
   `step 6/6 blocked: no element matching {"text":"Place order","role":"button","index":0}`, 주문 0건, 0호출.
4. **동일 capture를 heal 활성으로 실행** — 4회차(v3)에서 locator self-heal 1회, 호출 1회.
   복구본은 `Place order`를 `link`로 재동결했고 다른 단계·단언은 그대로다.
5. **복구본을 새 브라우저·초기화된 앱에서 재생** — 5·6회차(v3)는 4회차가 저장한 복구본 해시를
   재생했다(각 실행은 새 서버·브라우저·세션).
6. **마지막 실행** — 6회차: 픽스처 완료(주문 1건), verdict 통과, 엔진·관측 호출 0.

| 모델 | 발견(1회) | 복구(4회차) | 복구 후 재생(5·6회차) | 6회 누적 cairn | 6회 누적 agent |
| --- | ---: | ---: | ---: | ---: | ---: |
| Sonnet 5 | $0.042799 · 7호출 · 15,119토큰 | $0.006370 · 1호출 · 1,299토큰 | 2/2 통과 · 0호출 | $0.049169 · 8호출 | $0.265392 · 42호출 |
| Opus 5 | $0.087434 · 7호출 · 14,476토큰 | $0.013444 · 1호출 · 1,215토큰 | 2/2 통과 · 0호출 | $0.100878 · 8호출 | $0.545089 · 42호출 |

- 복구 성공: 시도 3회 중 3회(파일럿 Sonnet 1, 본 측정 Sonnet 1·Opus 1). 본 측정만 보면 2/2.
  분모는 실제 복구 시도 수다.
- 전체 시도 24/24 성공(파일럿 3/3 별도). 재생 10회(파일럿 1회 별도)는 모두 LLM 0회.
- 교차점은 두 모델 모두 2회차. agent 방식은 4회차 이후 v3에서도 매번 7호출로 탐색했다.
- 비용은 제공자가 반환한 API 정가 환산액이며 보조 모델(`claude-haiku-4-5-20251001`) 몫을 포함한다.
  복구 1호출의 모델별 몫: Sonnet $0.005276 + Haiku $0.001094, Opus $0.012350 + Haiku $0.001094.
  이번 실행의 토큰 필드는 모두 보고됐다(`usageComplete: true`).
- 두 모델이 얼린 단언은 `no-failed-requests`·`no-console-errors`·`navigated /done`이며
  `/api/order`에 대한 `request-status`는 얼리지 않았다. 목표 달성은 verdict와 별개로 픽스처
  오라클(`orderCount: 1`, `complete: true`)로 확인했고, `/done`은 서버가 주문 1건일 때만 응답한다.

### capture 해시

| 실행 | freeze(v1) | 복구본(v3, 4회차 저장) | 5·6회차가 재생한 해시 |
| --- | --- | --- | --- |
| Sonnet 5 | `08c942178614ed359a7e31ef964bc3fcbd6430cacbff315e1042e52b3b3ecf76` | `f46e052a15ea71e1497ad00322d4633624591e55bd2b3399bb42999b6d87808b` | 복구본과 동일 |
| Opus 5 | `f0661ce360ad9a46dc770cf30b704f729ee155a4c1b8aa11b7d759093e4ecf76` | `96983640e667c4be9152949b19d1a3747bf9b78ce7b2d128e4391df65266bd88` | 복구본과 동일 |

픽스처 SHA-256은 v1 `62a54b68c644cf8e…`, v3 `f9b459bbcfd871fc…`(전체 값은 JSON).

## 파일럿

`bench/local/heal.pilot.claude-sonnet-5.json`(SHA-256 `070a39c3…6cb6d10ab`, cairn 단독, `v1, v3, v3`,
40호출·$1 상한)으로 본 측정 전에 v3가 실제 모델의 freeze를 깨는지 확인했다. 결과: 발견 7호출
$0.048760, 복구 1호출 $0.006362, 복구본 재생 0호출 통과. 본 측정에 합산하지 않는다.

## 근거 자료

- [`230-claude.json`](230-claude.json): 원본 `results.json`의 부분집합(절대 경로·스택·ledger 제외),
  시도별 기록·요약·capture 해시·단계, 원본 파일의 SHA-256. 원본은 gitignored
  `bench/results/heal-{pilot-sonnet,sonnet,opus}-1/`과 `heal-{sonnet,opus}-1-replay-{v1,v3}/`에 있다.
- [`230-evidence.mjs`](230-evidence.mjs): 원본 디렉터리에서 위 JSON을 만들고(`distill`), JSON만으로
  표를 다시 그린다(`table`). 새 모델 호출 없음.

```sh
node docs/benchmarks/230-evidence.mjs table docs/benchmarks/230-claude.json
```

## 재실행

저장소 루트, 위 커밋의 깨끗한 체크아웃에서. 출력 디렉터리는 새 경로여야 한다.

```sh
ENGINE_COMMIT=$(git rev-parse HEAD)
npm run bench:local -- cost --config bench/local/heal.claude-sonnet-5.json --runs 6 \
  --engine-commit "$ENGINE_COMMIT" --out bench/results/heal-sonnet-new
npm run bench:local -- replay --config bench/local/heal-replay.v1.json --runs 1 \
  --engine-commit "$ENGINE_COMMIT" --captures bench/results/heal-sonnet-new/captures \
  --out bench/results/heal-sonnet-new-replay-v1
npm run bench:local -- replay --config bench/local/heal-replay.v3.json --runs 1 \
  --engine-commit "$ENGINE_COMMIT" --captures bench/results/heal-sonnet-new/captures \
  --out bench/results/heal-sonnet-new-replay-v3
node docs/benchmarks/230-evidence.mjs distill out.json sonnet=bench/results/heal-sonnet-new \
  sonnet-replay-v1=bench/results/heal-sonnet-new-replay-v1 sonnet-replay-v3=bench/results/heal-sonnet-new-replay-v3
```

Opus는 설정 파일과 출력 이름을 바꾼다. GPT-5.6 Sol/Terra/Luna는 `bench/local/heal.gpt-5.6-*.json`
(같은 여정·버전 일정·지연·`maxSteps`, Codex medium, 160호출 상한)을 그대로 쓴다. 두 번째 replay
명령(v3)은 **실패해야** 정상이며 CLI가 종료 코드 1을 돌려준다.
