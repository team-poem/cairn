# 2026-07-06 — #96 쿼리/해시-전용 이동에 URL expect 얼리지 않기

- **브랜치:** `fix/96-query-hash-expect` (origin/develop 기준, 묶음 A 스택의 1번)
- **근원:** `assignStepExpects`(#81 산물, `8f696bc`)가 이동 감지는 **풀 URL**(`urlAfter !== mark.url`)로,
  expect 동결은 **host+path**(`destinationKey`)로 — 감지/동결 granularity 불일치. 쿼리·해시만 바뀌면
  (`/list?page=1 → ?page=2`, `/app → /app#/cart`) 얼려진 expect가 이동 *전* 페이지에서 이미 참 →
  replay 사전체크(idempotency)가 클릭을 조용히 skip하고 ok 보고.
- **수정:** URL expect는 `destinationKey(urlAfter) !== destinationKey(mark.url)`일 때만 부여.
  아니면 mutation expect(`freshMutationExpect`)로 폴스루 — 발사된 요청이 더 강한 증거.
  mutation도 없으면 expect 없음(약한 expect는 false divergence 유발이라 기존 원칙 유지).
- **테스트:** 177 → 188. 신규 = 쿼리-전용→mutation 폴스루 · 해시-전용→no expect ·
  **URL 코퍼스(설계 장치 ②) 착수** — `test/support/url-corpus.ts`의 `DESTINATION_CHANGE_CORPUS`
  (쿼리/해시/트레일링 슬래시/부모≠자식/호스트 변경 등 9케이스) 테이블 구동. 회귀 테스트는
  `assignStepExpects`(capture 경로)에 걸었다 — 계보가 #81이지 #56(`urlReached`)이 아니므로.
- **state 변화 제안:** 2.4.0 묶음 A 중 #96 구현 완료(2.3.1 패치 후보). 코퍼스 파일 신설
  (#86·#87 브랜치가 이 파일을 확장).

Assisted-by: Claude Fable 5
