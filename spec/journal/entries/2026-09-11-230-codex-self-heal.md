# #230 — GPT self-heal 실측과 README 통합

`codex/230-codex-benchmark`의 격리 worktree에서 수행. Claude 세션의
`apps/cairn-230-selfheal`은 원본 자료를 읽기만 했다. PR #233 브랜치에 결과를 추가한다.

## 측정과 검증

- 사용자 인계대로 공통 소스 `45adbb87b1507c1569771f2af1cb0891fc8d3cc4`의 깨끗한 체크아웃에서
  Sol·Terra·Luna, 모두 medium, 기존 `heal.gpt-5.6-*.json` 그대로 실행했다.
  빌드는 한 번 수행하고 모델별 CLI를 동시에 실행했으며, 시도마다 서버·브라우저·상태가 격리됐다.
- 본 측정 36/36 성공, 실제 locator 복구 3/3 성공. 모델별 발견 7호출, 4회차 복구 1호출,
  5·6회차는 복구본 해시로 재생해 엔진·관측 호출 모두 0. 각 시도 주문 1건을 오라클로 확인했다.
- Sol 발견 85,720토큰·복구 11,417토큰, Terra 83,988·11,421, Luna 74,028·9,994.
  CLI 달러 비용 미보고로 비용은 unknown 유지. 단가 추정이나 달러 교차점은 추가하지 않았다.
- 원본 freeze를 heal 비활성으로 대조: 모델별 v1 통과, v3는 마지막 버튼을 찾지 못해 실패.
  모두 0호출이며 v3 주문 0건이다. 예상 실패를 본 측정 실패나 누락으로 세지 않았다.
- GPT 파일럿·재시도·예산 중단·제외한 실행 없음. Claude와 합친 본 측정 60/60,
  복구 5/5, 복구 후 재생 10/10·0호출. Claude 파일럿은 별도다.
- 세 모델 모두 마지막 target role만 button → link로 바뀌었고 intent·expect·단언은 보존됐다.
  단언은 가드 두 개와 `/done` 도착이며 주문 request-status는 없다. 주문 증명은 오라클 소유다.
  `waitFor.text`·step/outcome 복구 전체를 측정했다는 주장은 하지 않는다.

## 산출물

- Claude 결과 커밋 `db3a96a`를 fast-forward한 뒤 `230-codex.json`·`230-codex.md`를 추가했다.
- 정제기가 cost 기록의 `engineUsage`와 capture `assertions`를 보존하도록 보강했다.
  Claude JSON도 원본에서 재생성했고 기존 모든 필드 값이 불변임을 재귀 대조했다.
- 양쪽 JSON의 원본 SHA-256과 바이트 단위 재생성, 원본·복구본 해시 계보를 직접 검증했다.
- 두 README에 기존 rename 벤치와 별도인 실제 self-heal 표를 추가했다. npm 문서는 원격 링크를
  사용하고 두 문서의 표·설명은 동일하다. bench 안내에도 실측 자료를 연결했다.
- 타입체크·빌드·워크스페이스 1,164 테스트·벤치 159 테스트 통과. 최초 샌드박스 테스트에서
  tsx 로컬 IPC가 EPERM으로 차단된 원인을 확인한 뒤, 소켓 허용 환경에서 같은 전체 suite를 통과했다.

state 변화: #230의 공통 벤치, 다섯 모델 실측, 복구 후 재사용 근거와 README 통합이 갖춰졌다.
PR #233 검토·develop 병합 시 종결 가능하다. #229·#231 및 엔진 코드는 수정하지 않았고
릴리즈 PR #207은 머지하지 않았다. `state.md`와 기존 journal entry는 수정하지 않았다.
