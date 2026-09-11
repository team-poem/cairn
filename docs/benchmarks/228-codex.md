# PR #228 — Codex 5.6 측정

이 측정은 매번 탐색하는 방식과 한 번 탐색한 뒤 재생하는 방식을 같은 로컬 여정에서 비교한다.
모델 간 품질 순위나 실제 서비스의 비용을 추정하는 벤치마크가 아니다.

## 조건

- 모델: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`. 추론 수준은 모두 `medium`.
- 여정: 이동, 비동기 폼 저장, 로그인 → 장바구니 → 주문.
- 각 모델·여정·방식마다 6회. 모델당 36회, 총 108회.
- 버전: `v1, v1, v1, v2, v2, v2`. 두 방식 모두 4회차에 같은 이름 변경을 만난다.
- 문서 지연: `[0, 20]`ms, API 지연: `[0, 40]`ms, `maxSteps: 20`.
- PR의 Claude 설정과 여정·버전·지연·단계 제한을 동일하게 유지했다.
- 모델별 최대 160회 호출. 달러 비용을 보고하지 않는 CLI이므로 금액 제한은 선언하지 않는다.
- 세 모델을 동시에 측정하되 각 시도는 별도 서버·Chrome 프로필·상태를 사용한다.
  이 실행의 경과 시간으로 모델의 속도를 비교하지 않는다.

측정 소스는 `ee4dfe3105360e7471ba14c77542177998267dcf`의 깨끗한 체크아웃이다.
Codex CLI `0.146.0`, Chrome `153.0.8010.36`, Node `26.5.1`, Chrome DevTools MCP
`1.8.0`을 사용했다. 실제 런타임·빌드 해시와 시도별 기록은 [JSON 근거 자료](228-codex.json)에 있다.
이동 여정의 사전 파일럿과 LLM 없는 연결 검증은 본 측정에 합산하지 않았다.

## 결과

108/108 시도가 성공했고, 45회의 재생은 모두 LLM 0호출이었다. 전체 300회 LLM 호출의 토큰
필드가 모두 보고됐다. 재동결된 복구는 0회이며, 모든 달러 비교·교차점·차트는 보류됐다.
아래 수치는 각 방식의 6회 실행 누적값이다.

| 모델 | 여정 | 매번 탐색 | 한 번 탐색 후 재생 | 성공 | 복구 |
| --- | --- | ---: | ---: | ---: | ---: |
| GPT-5.6 Sol | navigation | 211,901 tokens · 18 calls | 35,319 tokens · 3 calls | 12/12 | 0 |
| GPT-5.6 Sol | form | 285,563 tokens · 24 calls | 47,431 tokens · 4 calls | 12/12 | 0 |
| GPT-5.6 Sol | stateful | 506,120 tokens · 42 calls | 84,088 tokens · 7 calls | 12/12 | 0 |
| GPT-5.6 Terra | navigation | 211,858 tokens · 18 calls | 35,310 tokens · 3 calls | 12/12 | 0 |
| GPT-5.6 Terra | form | 285,457 tokens · 24 calls | 47,420 tokens · 4 calls | 12/12 | 0 |
| GPT-5.6 Terra | stateful | 504,711 tokens · 42 calls | 83,956 tokens · 7 calls | 12/12 | 0 |
| GPT-5.6 Luna | navigation | 187,189 tokens · 18 calls | 31,035 tokens · 3 calls | 12/12 | 0 |
| GPT-5.6 Luna | form | 314,858 tokens · 30 calls | 41,760 tokens · 4 calls | 12/12 | 0 |
| GPT-5.6 Luna | stateful | 448,690 tokens · 42 calls | 74,978 tokens · 7 calls | 12/12 | 0 |

Luna의 폼 여정은 매번 탐색에서 30호출, 한 번 탐색에서 4호출이었다. 모든 모델·여정에
동일한 호출 비율을 가정하지 않고 관측값을 그대로 표시했다. 이번 실행의 성공은 이 픽스처와
일정에 대한 결과이며 일반적인 무실패 확률을 뜻하지 않는다.

### Claude 기존 측정

[PR #228](https://github.com/team-poem/cairn/pull/228)이 제공한 기존 수치다. 이번 Codex 실행에서
재측정한 값은 아니며 원본 Claude JSON은 이 근거 자료에 포함하지 않는다.

| 모델 | 여정 | 매번 탐색 | 한 번 탐색 후 재생 |
| --- | --- | ---: | ---: |
| Sonnet 5 | navigation | $0.109 · 18 calls | $0.018 · 3 calls |
| Sonnet 5 | form | $0.151 · 24 calls | $0.025 · 4 calls |
| Sonnet 5 | stateful | $0.269 · 42 calls | $0.046 · 7 calls |
| Opus 5 | navigation | $0.208 · 18 calls | $0.030 · 3 calls |
| Opus 5 | form | $0.255 · 24 calls | $0.042 · 4 calls |
| Opus 5 | stateful | $0.463 · 42 calls | $0.077 · 7 calls |

## 집계의 의미

호출 수는 벤치가 LLM 클라이언트의 `complete`를 호출한 횟수다. CLI 내부의 재연결은
별도 호출로 세지 않는다. CLI는 사용자 설정·프로젝트 지침·shell·web 도구·세션 저장을
끄고 빈 임시 디렉터리에서 실행한다. CLI가 다른 모델로 전환했다고 보고하면 해당 시도를
성공한 원래 모델의 결과로 집계하지 않는다.

토큰 수는 입력·캐시 읽기·캐시 쓰기·출력을 합친 값이다. Codex의 `input_tokens`에는
캐시 읽기와 쓰기가 포함되므로 일반 입력에서 두 몫을 빼고, 출력에 포함된 추론 토큰은 다시
더하지 않는다. 이 분리는 [공식 토큰 집계 예시](https://developers.openai.com/cookbook/articles/per_run_spending_controller_responses_api#example-set-a-budget-for-a-support-ticket)를 따른다.
CLI가 필드를 생략하면 완전한 합계라고 표시하지 않는다.

Codex CLI는 이 실행에서 달러 비용을 반환하지 않았다. 토큰 수를 가격표에 곱하지 않았으며,
금액이나 비용 역전 시점도 제시하지 않는다. Claude의 달러 수치는 PR 작성자의 별도 실측이고,
제공자가 반환한 API 정가 환산액이다. 구독 요금의 실제 추가 결제액을 뜻하지 않는다.

탐색 성공은 재생 가능한 시나리오를 얻고 픽스처의 완료 상태에 도달한 경우다. 재생은 여기에
얼린 단언의 통과도 요구한다. 따라서 두 방식의 실패율은 동일한 판정 절차의 측정치가 아니다.
단순한 이름 변경을 역할·위치로 흡수하는 것과 LLM을 호출해 수리하는 self-heal은 구분한다.
복구 전용 픽스처의 측정은 [#230](https://github.com/team-poem/cairn/issues/230)의 범위다.

## 재실행

저장소 루트에서 실행한다. 각 출력 디렉터리는 새 경로여야 한다.

```sh
ENGINE_COMMIT=$(git rev-parse HEAD)
npm run bench:local -- cost --config bench/local/cost.gpt-5.6-sol.json --runs 6 \
  --engine-commit "$ENGINE_COMMIT" --out bench/results/codex-sol-new
```

Terra·Luna는 설정 파일과 출력 디렉터리를 해당 모델의 이름으로 바꾼다.
설정 파일은 동일한 여정·일정을 명시하고 있다. 실제 LLM 호출을 사용하며, 호출 상한은
요금 상한이 아니다. 원본 `results.json`·Markdown·시나리오는 출력 디렉터리에 저장된다.
JSON 근거 자료는 원본 보고서의 부분집합이며 절대 파일 경로·스택·중복 ledger를 제외했다.
원본 보고서와 설정의 SHA-256을 함께 기록했다.
