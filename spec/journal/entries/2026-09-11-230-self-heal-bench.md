# #230 — self-heal 실측 (Claude 측)

`feat/230-self-heal-bench`(origin/develop `de79788` 기준). 기존 벤치는 v2 이름 변경을 역할·위치
fallback이 흡수해 복구가 0회였다. fallback이 못 푸는 변경을 v3로 넣고 실제 모델로 복구 흐름을 쟀다.

## 벤치 변경 (`45adbb8`, 측정 소스)

- 픽스처 v3: `stateful` 장바구니의 `Place order`가 `<button>` → `<a href="/done">`. 이름·`/api/order`
  POST·`/done` 완료는 그대로, 나머지 라벨은 v1 유지. 다른 tier의 v3는 거부. v1/v2 바이트 불변.
- cost 요약에 `phases`(discovery / repair / replay: runs·passed·calls·tokens·costUsd, repair는
  `refrozen` 포함) 추가, Markdown에 세 줄로 출력. 복구 시도는 재동결 여부와 무관하게 비용에 센다.
- 공유 설정: `heal.claude-{sonnet,opus}-5.json`, `heal.gpt-5.6-{sol,terra,luna}.json`(6회, 4회차부터
  v3, 기존 지연·`maxSteps`·상한), `heal.pilot.claude-sonnet-5.json`(cairn 단독 3회),
  `heal-replay.v{1,3}.json`(LLM 금지 replay). `docs/benchmarks/230-evidence.mjs`(정제·표 재생성).
- 스크립트 소스로 v3 재생이 `step 8/9 blocked: no element matching … role button`으로 0호출 실패하는
  것을 커밋 전에 확인(연결 검증, 근거 자료 제외).

## 측정 (Sonnet 5 · Opus 5, 동시 실행, 2026-09-11 08:45–08:51 UTC)

- 파일럿 Sonnet(v1, v3, v3): 발견 7호출 $0.0488 → 복구 1호출 $0.0064 → 재생 0호출 통과.
- 본 측정 24/24 성공, 실패·예산 중단·재시도 0. 복구 시도 2/2 성공(파일럿 포함 3/3).
  - Sonnet: 발견 $0.042799·7호출, 복구 $0.006370·1호출·1,299토큰, 5·6회차 0호출 통과.
    cairn 6회 누적 $0.049169·8호출 vs agent $0.265392·42호출.
  - Opus: 발견 $0.087434·7호출, 복구 $0.013444·1호출·1,215토큰, 5·6회차 0호출 통과.
    cairn 6회 누적 $0.100878·8호출 vs agent $0.545089·42호출.
- 같은 freeze를 LLM 금지 replay로 v1에 재생하면 통과, v3에 재생하면 두 모델 모두
  `step 6/6 blocked … "Place order","role":"button"` 실패(0호출). heal 활성 4회차는 `Place order`를
  `link`로 재동결했고 5·6회차는 그 해시를 재생했다.
- 두 모델 모두 `/api/order`의 `request-status`는 얼리지 않았다(`navigated /done` + 가드 2종).
  목표 달성은 픽스처 오라클(`orderCount: 1`)로 별도 확인.
- 엔진 결함으로 측정이 막힌 일은 없다. 엔진 코드는 건드리지 않았다(빌드 해시 #228과 동일).

근거: `docs/benchmarks/230-claude.md`·`230-claude.json`. 원본은 gitignored `bench/results/heal-*`.
검증: `npm test`(워크스페이스 1,164 + 벤치 159) 통과.

## 남은 일 (다른 세션)

GPT-5.6 Sol/Terra/Luna를 같은 커밋 `45adbb8`에서 `heal.gpt-5.6-*.json`으로 실측, 양쪽 결과와 README
통합. #230은 그 뒤에 닫는다.

state 변화: #230 Claude 측 실측 완료, GPT 실측·README 통합 대기. 새 공개 API나 엔진 동작 변경은 없다.
