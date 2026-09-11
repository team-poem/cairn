# PR221 — 공식 관찰 대기 옵션 구현·검증, SDK timeout 후속 대기

- 브랜치: `codex/198-perception-design`. 측정한 구현 HEAD `074be67682c924647477fa2eea87b3b165e8b6d7`.
- 상태: 사용자가 승인한 성능 회귀8개와 기존 테스트2줄 변경을 구현했다. 독립 검토에서 SDK 자체 timeout 분류 누락을 발견했고, 재현2개를 계획에 추가해 승인을 요청했다. **PR 최종 완료·최종 gate 통과·merge/release는 아직 아니다.**

## 구현

기본 ChromeDevTools MCP를 정확한1.8.0과 공식 `--no-page-id-routing`으로 실행한다. 기존 selected-page/UID 프로토콜과 사용자 지정command/args는 유지한다. 연결당 tools/list1회로 evaluate_script의waitForStableDom boolean을 확인하고, 연결 초기화 후 실제 인자를 만들 때 관찰 호출에만false를 추가한다. 첫guard도 같은 경로다.

관찰3종(guard설치·facts·ref검증)의5개 평가 경계와 UID인자·검증본문은 그대로다. 실제 입력, scroll, legacyprobe는 일반 대기를 유지하며 관찰에서도 navigation 대기는 남는다. 미지원·잘못된schema는 기존 평가로 동작하고, 평가오류를 인자만 바꿔 재시도하지 않는다. 자체MCP패치/별도브라우저연결/실제LLM 호출은 없다.

## 검증

- 추가8개 각각 기존구현에서 RED를 확인한 뒤 원문으로 순차 편입했다. 기존3줄trace승인 외에 이번에는 기본실행test의제목·기대인자2줄만 승인대로 변경했다. 다른 기존test/helper/fixture는 수정하지 않았다.
- 전체 suite: engine1155 + root69 GREEN. 실제Chrome21개 GREEN. typecheck/build/check:boundaries GREEN.
- npm·pnpm tarball소비자: 공개타입·설치CLI·browserbundle·Chromequickstart 모두PASS. 원래8개와header 원문 일치, 이번까지5줄 승인 변경 일치 확인.
- 실제기본옵션driver가MCP1.8.0을 실행했고, 초기tools/list1회가약3ms였다. 임시브라우저·선택대상확인까지성공했다.
- 실제1.8과사용자지정구형1.3에같은guard matrix PASS: exact selection/fresh-driver replay, incidentalchange허용, node교체·동명삽입·rename거부, verbose-only ref거부, peerUID20_8→22_5의원래DOM동일성, compact실패후만료. 구형1.3에는새옵션을보내지않았다.
- 실제1.8에서native/customselect, 동일탭navigation, 새탭follow, confirm수락, 실제iframe행이있을때전체ref생략을확인했다. confirm처리는MCP가open-dialog오류를낸뒤수락하는약5초경로도포함하며일반click지연과같다고주장하지않는다.

## 실제 구현 성능

MCP1.8.0·격리로컬Chrome. 경로별warmup2회+측정12회,5경로60측정액션모두정확한DOM대상확인. 실제production코드를호출했고계측은인자·결과·오류를그대로전달한다. monkeypatch나계측기의wait옵션주입은없다. source chrome.ts SHA256: `c305c0cc4eccba36ac8991f460b21b449fe3795382a641a5d0abf15c36be5052`.

| 경로 | 호출 수 | p50 / p95(ms) |
|---|---:|---:|
| 변경없는ref |13|751.2 /765.4|
| enrichment전무관한변경 |15|862.2 /871.5|
| dispatch전무관한변경 |15|862.5 /864.9|
| compact중무관한변경 |15|861.5 /865.3|
| 기본legacy선택 |4|433.4 /450.4|

같은공식1.8의기존대기측정(n3)1284.5→751.2ms,약42%개선이다. 호출수는같고관찰evaluate중앙값약103ms, 일반evaluate약204ms였다. startup/navigation/settle/LLM/검증호출·인위적변경주입은행위비용에서제외했다. n12의nearest-rank p95는표본최댓값이며production SLO가아니다. 최초실험의0.23초는배포안성능으로인용하지않는다. 사용자는약0.77초의공식옵션방향으로구현을승인했다.

## gate와 남은 후속

workspace gate수정은사용자의1회소유권예외승인으로별도rootcommit `3a5ad7f`에있다. 이전완료47개에대해기준1920886을유지하고정확한trace3줄승인자료로정식gate PASS를확인했다. 이번에는기존3줄+버전2줄의정확한5개승인자료를준비했다. baseline을옮기거나검사를우회하지않는다.

현재계획55개는완료이며추가SDKtimeout2개는승인대기다. SDK의RequestTimeout(-32001)이driver의더긴timeoutMs보다먼저발생하면이를선택기능미지원으로오인해연결을성공시키는경로를실제McpError객체로재현했다. API snapshot과최소초기화case모두RED. 기존8개나header는바꾸지않았다. 승인후구조화된SDKtimeout을fatal초기화오류로처리하고,57개본문확인·전체suite·정식gate를통과시킨뒤PR을최종반영한다. 이추가수정은위성능측정에포함되지않았다.

검증자료: `/tmp/cairn221-phase4-final-measure-report.md`, `...-final-production-results.json`, `...-final-consumer-npm.log`, `...-final-consumer-pnpm.log`, `...-final-browser.log`, `...-sdk-timeout-review.md`, `...-final-gate-approvals.json`.

state변화제안: PR221의관찰대기최적화는공식옵션구현·실측까지진행됐다. SDKtimeout후속과57개최종gate/PR반영이남았다. state.md는develop에서후속완료후갱신한다. Brain/skills/harness는이번앱구현에서추가변경하지않았다.
