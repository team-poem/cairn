# 다른 환경에서 frozen 시나리오 재생하기

`replayEnvironment`는 저장된 시나리오를 실행할 때만 다른 origin으로 옮긴다.
원본 객체와 skill 파일은 유지하며, 옵션을 생략하면 기존 재생 동작을 사용한다.

## CLI

```sh
cairn replay checkout.skill.json \
  --base-url http://localhost:3000 \
  --allowed-hosts shop.example.com,api.example.com,localhost:4000

cairn run --scenario checkout.skill.json \
  --base-url http://localhost:3000 \
  --allowed-hosts shop.example.com,api.example.com,localhost:4000
```

`--base-url`은 대상 origin이다. HTTP(S) 주소와 선택적인 마지막 `/`만 허용하며,
경로 접두사·query·hash·자격증명은 받지 않는다. 기존 페이지의 경로를 그대로 사용한다.

`--allowed-hosts`에는 원본 페이지 호스트와 환경 간 매칭을 허용할 API 호스트를
쉼표로 나열한다. 위 예에서는 `shop.example.com`의 페이지를 localhost:3000으로
옮기고, `api.example.com`의 요청 조건을 localhost:4000의 같은 경로 요청으로
검증할 수 있다. 대상 origin의 호스트는 요청 매칭 허용 목록에 자동으로 포함된다.
호스트는 포트까지 비교하며 하위 도메인을 자동 허용하지 않는다. DNS 대소문자,
국제화 도메인과 IPv6 표기는 정규화하지만 명시한 `:80`과 `:443` 범위는 구분한다.

## 라이브러리

```ts
import { loadSkillFile, runScenario } from "cairn-engine";

const scenario = await loadSkillFile("checkout.skill.json");
const { result } = await runScenario(scenario, {
  replayEnvironment: {
    baseUrl: "http://localhost:3000",
    allowedHosts: ["shop.example.com", "api.example.com", "localhost:4000"],
  },
});
```

기계적 단언만 있는 정상 재생은 LLM을 호출하지 않는다. 기존의 자연어 `expect`
단언과 `heal`의 LLM 사용 조건은 동일하다.

## Suite의 캐시 재사용

```sh
cairn suite cases.json --skills ./skills \
  --replay-base-url http://localhost:3000 \
  --allowed-hosts shop.example.com,api.example.com,localhost:4000
```

Suite의 기존 `baseUrl`과 CLI `--base-url`은 발견 당시의 시작 URL 및 캐시 지문에
계속 사용한다. 실행 환경만 바꿀 때는 `--replay-base-url` 또는 라이브러리의
`runSuite(cases, { replayEnvironment: ... })`를 사용한다.

이 모드는 기존 캐시만 재생한다. 파일이 없거나 사례의 입력과 캐시 지문이 다르면
해당 사례를 실패 처리하며, 브라우저·LLM을 이용한 재탐색이나 저장은 수행하지 않는다.

## 변환과 저장 범위

- 허용된 호스트의 `goto.url`, 스텝의 `expect.url`, `waitFor.until.url`,
  `navigated.to`를 함께 변환한다. 기존 경로·query·hash·와일드카드를 보존한다.
- 요청 기대값은 원본 그대로 둔다. 기대 호스트와 실제 요청 호스트가 모두 허용된
  경우에만 호스트를 제외해 원래 경로 접두 조건과 query 부분집합 조건을 비교한다.
  HTTP method와 status 조건도 유지한다.
- 호스트만 있거나 루트 경로만 있는 요청 조건에는 환경 간 매칭을 적용하지 않는다.
  호스트만 있는 목적지 단언도 원래 범위를 유지한다. 페이지 진입용 루트 `goto`는
  대상 환경의 루트로 옮길 수 있다.
- 외부 결제 페이지 등 허용 목록 밖의 URL, custom params, 타깃 문자열과 자연어
  단언은 그대로 둔다. custom 코드와 리포터는 실제 실행 환경의 관측 증거를 받는다.
- `heal`은 대상 환경에서 임시 복구와 판정까지 수행할 수 있다. 이 모드에서는
  `healedScenario`를 반환하지 않으며 suite도 복구 결과를 저장하지 않는다.
  CLI에서 `--freeze`와 함께 지정하면 사용법 오류다. `--heal` 실행이 끝나면
  콘솔과 JSON은 임시 복구를 포함한 최종 판정과 증거를 표시한다.

이 옵션은 frozen 데이터의 실행 환경을 바꾸는 기능이다. 앱 자체의 링크·리다이렉트·
네트워크 요청을 다시 쓰거나 외부 origin으로의 접근을 차단하는 기능은 아니다.
