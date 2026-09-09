# 2026-09-08 — frozen 시나리오의 실행 환경 전환 (#171)

- **브랜치:** `codex/171-replay-environment` (기준 `868412e`, develop).
- **문제:** freeze의 절대 `goto` URL과 호스트를 포함한 목적지·요청 조건 때문에 다른 환경 재생이 원본 환경을 방문하거나 잘못 실패했다.
- **결정:** 이슈와 분석을 spec으로 사용하고, 사용자가 검토한 실패 테스트를 순서대로 구현했다. `replayEnvironment: { baseUrl, allowedHosts }`를 실행 옵션으로 추가한다. HTTP(S) origin만 받고 정확한 호스트 목록으로 변환 대상을 제한한다. URL 경로·query·hash·bare 표기·wildcard와 target/custom 데이터의 정체성을 보존한다.
- **요청 판정:** frozen 기대 문자열은 변경하지 않는다. 기대·실제 호스트가 모두 허용된 경우에만 경로 접두와 query 부분집합을 비교한다. method/status·watermark·진단도 같은 matcher를 사용한다. 루트·호스트만 있는 조건의 환경 간 fallback은 금지한다. DNS/IDN/IPv6를 정규화하되 명시한 포트 범위를 유지한다. freeze가 생략한 기본 포트는 bare key와 실제 프로토콜 정보를 구분해 처리한다.
- **저장 계약:** 대상 환경의 heal은 임시다. 모든 경로에서 `healedScenario`를 반환하지 않는다. Suite는 원본 caseHash의 최신 캐시만 재생하고, 캐시 미스·stale은 브라우저/LLM 작업 전에 실패한다. 재탐색·재저장하지 않는다. CLI run/replay는 `--base-url`과 `--allowed-hosts`, suite는 `--replay-base-url`과 `--allowed-hosts`를 사용한다. `--freeze`와 동시 사용은 usage 오류다.
- **리뷰:** 호스트를 제거한 요청 경로가 중간 경로에도 매칭되던 문제와 기본 포트·IDN·IPv6 표기의 변환 불일치를 추가 승인된 회귀 테스트로 수정했다. 최종 리뷰에서 임시 outcome heal 성공 후 CLI가 최초 실패만 보여주던 결과 표시도 확인했다. 사용자가 승인한 CLI 회귀 테스트 2개를 추가하고, 환경 재생+heal에서 최종 결과를 Reporter로 다시 전달해 콘솔·JSON·종료 코드를 일치시켰다.
- **실제 Chrome:** 두 로컬 origin의 SPA 제출 흐름으로 라이브러리 재생 2회 + CLI 재생 1회 성공, POST 500 주입 시 실패. 원본 서버 요청 0회, 대상 POST 4회, LLM 0회, frozen 파일 바이트 불변을 확인했다. 첫 픽스처의 전체 페이지 이동은 기존 Chrome 드라이버가 요청 목록을 새 페이지로 초기화해 POST 증거가 사라졌다. 이 검증은 SPA 이동으로 실행했고 드라이버의 요청 보존 동작은 변경하지 않았다.
- **경계:** 앱 자체의 링크·리다이렉트·요청을 재작성하거나 네트워크 접근을 차단하는 기능은 아니다. 옵션 없는 실행 동작은 유지한다.
- **상태 변화:** #171을 develop에 병합하면 런타임 환경 전환 API/CLI를 사용할 수 있다. `state.md`는 feature branch에서 수정하지 않았다.

- **검증:** 기존 989개 + 신규 17개 = 전체 1,006개 테스트(49개 파일), typecheck·build·check:boundaries 통과. 브라우저 엔트리의 esbuild 번들링도 통과했다. 승인된 테스트를 원문 그대로 추가했으며 기존 테스트 수정은 없다. 독립 재리뷰에서 남은 결함 없음.
