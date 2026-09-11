# PR #228 — Codex 5.6 측정

이 측정은 매번 탐색하는 방식과 한 번 탐색한 뒤 재생하는 방식을 같은 로컬 여정에서 비교한다.
모델 간 품질 순위나 실제 서비스의 비용을 추정하는 벤치마크가 아니다.

## 읽는 방법

각 모델 안에서 매번 탐색과 한 번 탐색 후 재생을 비교한다. 제공자별 CLI 내부 처리·보조
모델 포함 범위·캐시 조건이 다르고 동일 품질을 검증하지 않았으므로, 모델끼리 달러 값을
나누어 일반적인 가격·품질 순위를 정하는 자료로 사용하지 않는다. Claude의 제공자 보고액과
Codex의 사후 단가 추정액은 아래에서 표를 나누어 제시한다.

README는 [Claude](228-claude-calls.svg)와 [Codex](228-calls.svg)의 호출 그래프를
상하로 나눈다. 두 그래프는 같은 0 기준 축척으로 주문 여정의 방식별 6회 누적 호출을
표시한다. 각 그룹의 모든 모델이 각각 42회 → 7회이며, 모델 간 합계나 평균이 아니다.
Claude는 [원 작성자가 실행 기록을 확인해 알려준 누적 호출 수](https://github.com/team-poem/cairn/pull/228#issuecomment-5629476331)를
[출처와 함께 저장](228-claude-calls.json)해 사용한다. Sonnet·Opus 모두 매번 탐색은
7·14·21·28·35·42회, 탐색 후 재생은 모든 실행에서 누적 7회다. 원본 Claude JSON은
여전히 gitignored 자료이며 이 저장소에는 작성자가 보고한 수열을 보존한다. Codex는
시도별 관측 기록을 사용한다. 두 제공자 모두 확인된 누적값을 점과 실선으로 표시한다.
[그래프 생성 스크립트](228-render-calls.mjs)는 새 모델 호출 없이 다음 명령으로 실행한다.

```sh
node docs/benchmarks/228-render-calls.mjs
```

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
필드가 모두 보고됐다. 재동결된 복구는 0회다. 원본 보고서는 달러 비용·교차점·차트를
보류하며, 아래에는 관측 토큰에 공식 단가를 적용한 별도 추정액을 추가했다.
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

원 PR의 Sonnet 비용 그래프도 함께 보존한다. 위 Claude 표 중 stateful 행의 제공자 보고액을
시각화한 것으로, Codex 단가 환산액과 합친 그래프가 아니다.

![Sonnet 5 주문 여정의 6회 누적 제공자 보고액: 매번 탐색 $0.269, 탐색 후 재생 $0.046](../cost.svg)

## 집계의 의미

호출 수는 벤치가 LLM 클라이언트의 `complete`를 호출한 횟수다. CLI 내부의 재연결은
별도 호출로 세지 않는다. CLI는 사용자 설정·프로젝트 지침·shell·web 도구·세션 저장을
끄고 빈 임시 디렉터리에서 실행한다. CLI가 다른 모델로 전환했다고 보고하면 해당 시도를
성공한 원래 모델의 결과로 집계하지 않는다.

토큰 수는 입력·캐시 읽기·캐시 쓰기·출력을 합친 값이다. Codex의 `input_tokens`에는
캐시 읽기와 쓰기가 포함되므로 일반 입력에서 두 몫을 빼고, 출력에 포함된 추론 토큰은 다시
더하지 않는다. 이 분리는 [공식 토큰 집계 예시](https://developers.openai.com/cookbook/articles/per_run_spending_controller_responses_api#example-set-a-budget-for-a-support-ticket)를 따른다.
CLI가 필드를 생략하면 완전한 합계라고 표시하지 않는다.

Codex CLI는 이 실행에서 달러 비용이나 서비스 티어를 반환하지 않았다. 아래 추정액은
원본의 `costUsd: null`이나 비용 비교 가능 여부를 바꾸지 않는다. 비용 역전 시점도 제시하지
않는다. Claude의 달러 수치는 PR 작성자의 별도 측정에서 제공자가 반환한 API 정가
환산액이다. 두 제공자의 수치 모두 구독 요금의 실제 추가 결제액을 뜻하지 않는다.

탐색 성공은 재생 가능한 시나리오를 얻고 픽스처의 완료 상태에 도달한 경우다. 재생은 여기에
얼린 단언의 통과도 요구한다. 따라서 두 방식의 실패율은 동일한 판정 절차의 측정치가 아니다.
단순한 이름 변경을 역할·위치로 흡수하는 것과 LLM을 호출해 수리하는 self-heal은 구분한다.
복구 전용 픽스처의 측정은 [#230](https://github.com/team-poem/cairn/issues/230)의 범위다.

## 달러 환산 — Standard API 단가 추정액

2026-09-11에 확인한 [OpenAI 공식 가격표](https://developers.openai.com/api/docs/pricing)의
Standard·짧은 컨텍스트 단가를 적용했다. CLI가 서비스 티어를 보고하지 않아 Standard는
계산 가정이다. Batch·Flex·Fast·지역 할증·세금·개별 계약은 반영하지 않는다.
단위는 **백만 토큰당 USD**다.

| 모델 | 일반 입력 | 캐시 읽기 | 캐시 쓰기 | 출력 |
| --- | ---: | ---: | ---: | ---: |
| GPT-5.6 Sol | $4.00 | $0.40 | $5.00 | $20.00 |
| GPT-5.6 Terra | $2.00 | $0.20 | $2.50 | $12.00 |
| GPT-5.6 Luna | $0.20 | $0.02 | $0.25 | $1.20 |

`추정 USD = (일반 입력 × 입력 단가 + 캐시 읽기 × 읽기 단가 + 캐시 쓰기 × 쓰기 단가 + 출력 × 출력 단가) / 1,000,000`

각 토큰 항목은 이미 서로 겹치지 않게 분리된 관측값이다. 캐시를 다시 빼거나 추론 토큰을
출력에 더하지 않는다. 실제 캐시 읽기에는 할인 단가를 적용했고, 캐시 쓰기는 이번 실행에서
0이었다. 별도 API 실행에서도 같은 캐시 적중률이 나온다는 예측은 아니다.
각 실행의 전체 입력 합계 최댓값은 Sol 84,672, Terra 84,652, Luna 75,529토큰이다.
이는 개별 요청 입력의 상한이므로 모두 짧은 컨텍스트 기준인 272,000토큰 이하다.
각 모델의 컨텍스트 기준 출처는 [단가 스냅샷](228-openai-prices.json)에 함께 기록했다.

아래는 위 토큰 표와 같은 **방식별 6회 누적 추정액**이며 소수점 여섯 자리로 반올림했다.

| 모델 | 여정 | 매번 탐색 추정 USD | 한 번 탐색 후 재생 추정 USD |
| --- | --- | ---: | ---: |
| GPT-5.6 Sol | navigation | ~$0.800158 | ~$0.088038 |
| GPT-5.6 Sol | form | ~$0.690454 | ~$0.082575 |
| GPT-5.6 Sol | stateful | ~$1.151334 | ~$0.150250 |
| GPT-5.6 Terra | navigation | ~$0.253984 | ~$0.039054 |
| GPT-5.6 Terra | form | ~$0.193528 | ~$0.031278 |
| GPT-5.6 Terra | stateful | ~$0.378848 | ~$0.056556 |
| GPT-5.6 Luna | navigation | ~$0.027633 | ~$0.001991 |
| GPT-5.6 Luna | form | ~$0.029719 | ~$0.004198 |
| GPT-5.6 Luna | stateful | ~$0.040743 | ~$0.004905 |

세 여정을 합친 모델별 추정액은 Sol **$2.641946 → $0.320862**, Terra
**$0.826361 → $0.126888**, Luna **$0.098095 → $0.011093**이다.
합계는 반올림하기 전의 값으로 계산했다.

[환산 JSON](228-codex-usd.json)은 방식별 토큰 항목·호출 수·반올림 전 추정액과 입력 파일의
SHA-256을 보존한다. [환산 스크립트](228-estimate-usd.mjs)는 정수 나노달러로 합산하며,
새 LLM 호출 없이 저장소 루트에서 다음 명령으로 같은 파일을 재생성한다.

```sh
node docs/benchmarks/228-estimate-usd.mjs
```

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
