# 2026-09-10 — PR #221 마지막 리뷰 재현과 릴리즈 비용 측정

- 기준: `codex/198-perception-design`, `1920886`. solp721의 issuecomment-5612161266 후속 리뷰.
- 사용자가 네 가지 수정과 두 sizing 항목의 측정을 진행하도록 승인했다. 이 entry 시점은 구현 전 Phase 0이며, 새 회귀 17개와 기존 trace 버전 3줄 예외는 검토 대기다. 기존 구현·suite는 변경하지 않았다.

## 재현

- 성공한 verbose 재시도 뒤 select가 오래된 compact watermark를 써서 재시도 대기 중 나타난 unrelated native Medium을 새 popup 옵션으로 오인한다. 실제 MCP 1.3.0 + 격리 Chrome에서도 opener만 클릭하고 no matching option timeout, 선택값 null을 확인했다.
- 실제 MCP는 compact에 빠진 UID를 매핑에서 지운다. 같은 DOM이 다음 verbose에서 다른 UID를 받았다(1_4→3_2). 성공 후 cache clear만 하면 verbose-only control UID를 무효화할 수 있다. 제안은 대기 후 compact watermark 갱신→verbose 마지막 캡처→dispatch 순서다. 대기 중 변경을 다루며 전역 snapshot/click 원자성을 주장하지 않는다.
- 가려짐·clickable region 중복·promotion quota를 상한 잘림에 더하는 오류 재현. 실제 eligible count에서 선택 수를 빼야 하고, quota 밖이어도 남긴 intent evidence는 eligible이다.
- perception/ref 거부는 두 루프의 내부 failure 문자열만 남고 trace는 비어 있다. additive gate 2종, 선택적 explore trace 및 trace1.6을 제안했다. bounded recovery/원래 callback 오류 전파를 유지하고 가짜 action/finding을 만들지 않는다.
- locator 시스템에 실행 action/reason 예제가 섞이는 계약 충돌을 실제 SelfHealingDriver prompt와 parser/dispatch를 통해 재현했다. locator name/ref/null 안내로 분리하면 공유 SYSTEM snapshot 변경은 불필요하다.
- 새 17건(캐시2·잘림6·진단7·locator prompt2)을 probe.sh로 개별 실행하여 의도한 assertion/동작 실패를 확인하고 git-excluded failed-test.md에 추가했다. 새 import/컴파일 오류를 RED로 계산하지 않았다. 잘림 6건 기대 개수는 별도 에이전트가 반증 관점으로 검토했다.

## 예산과 MCP 측정

실제/유료 모델 호출은 0이다. scripted model의 수율은 실제 모델 품질 측정이 아니다.

- 각 레이어 default5: 반복20호출에서 모두성공5·첫실패4·실패부터교대2·영구실패0, 요청은 모두5. 실제 단일 재생은 첫 미복구 단계에서 중단하므로 cap10/20도 실패를 재시도하지 않는다. 정상5스텝은0요청, 모두복구5스텝은5요청성공, 6스텝은6번째중단. 두레이어를 모두 사용하면 locator5+step5=10요청이 가능하다. per-layer5 유지와 정확한 계약 설명을 제안했다.
- 실제 MCP1.3.0은 드라이버의 ~1.3.0 pin과 일치한다. 7경로×12회, warmup각2회. 기본 옵션 두경로도12회씩 보완했다.
- 기본옵션 capture→locateRef→click:13콜, p50/p95=1244/1265ms. legacy capture→locate→click:4콜,413/423ms. clickable promotion을 끈 비교에서는 legacy3콜207/211ms, unrelated mutation ref15콜1440–1450/1465–1477ms, verbose fallback4콜514/517ms였다.
- 시작/이동/settle/LLM/검증호출·인위적변경주입은 비용에서 제외했다. 12개 nearest-rank p95는 표본최댓값이며 production SLO가 아니다. root가 원시JSON과 MCP 구현의 evaluate_script→waitForEventsAfterAction 및100ms+100ms 대기를 직접 확인했다.
- evaluate_script의 읽기에도 약200ms가 붙고 list_pages는약1ms다. 검사 삭제는 비동기 경계 보호를 약화한다. MCP1.3.0에는 읽기 대기 생략 공개옵션이 없다. 성능은 최종HEAD재측정 후 소비자 허용치 수용 또는 안전한 최적화까지 릴리즈 미완료 항목이다.

## state 변화와 산출물

로컬 review 문서는 `/tmp/cairn221-phase3-review-plan.md`, spec.md/failed-test.md는 clone-local. `/tmp/cairn221-phase3-{cache,diagnostics,measure}-report.md`와 `{budget,mcp,mcp-defaults}-results.json`에 재현 명령·세부로그·원시측정이 있다. existing-test-exceptions.patch는 trace1.5→1.6의 test title1줄/assertion2줄뿐이다. 기존30건 승인 이력은 유지한다. 새 코드·커밋·push·merge·release는 이 단계에서 수행하지 않았다. develop 소유 state.md는 그대로 둔다.

## Reflect

- Brain: 루트 하네스 제한으로 변경 없음.
- Skills: 변경 없음.
- Structural: 구현 전 검토안에 실제 MCP UID 수명·대기시간 원인을 검증 조건으로 넣음.
- Todos: 루트 추가 없음. 최종 수정과 성능 릴리즈 판단은 이 PR의 남은 작업.
