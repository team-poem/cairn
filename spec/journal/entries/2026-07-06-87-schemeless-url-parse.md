# 2026-07-06 — #87 스킴 없는 frozen expect.url의 `new URL()` 오파싱 차단

- **브랜치:** `fix/87-schemeless-url-parse` (#86 위에 스택, 묶음 A의 3번)
- **근원:** frozen 값은 스킴 없는 host+path(`"localhost:3000/mentor"`)인데 `new URL()`은
  throw하지 않고 **조용히 오파싱**(`localhost:`가 스킴, host `''`, path `'3000/mentor'`) —
  try/catch 폴백이 영원히 안 탐. 포트 달린 목적지는 replay 첫 URL expect부터 영구 발산.
- **수정:** `splitHostPath`(urlReached의 파서)가 입력이 `/^https?:\/\//i`에 매칭될 때만
  `new URL()` 사용, 아니면 수동 host/path 분리. 스킴이 있는데도 malformed면 수동 분리로 폴백
  (기존 catch 견고성 유지).
- **테스트:** 216 → 223. 코퍼스에 스킴 유/무 변형 7케이스 추가(포트+스킴리스 want ·
  host root · 양쪽 스킴리스 · want에만 스킴 · 포트+부모≠자식 경계 · 포트+다른 라우트).
- **state 변화 제안:** #87 구현 완료 — 묶음 A(#96·#86·#87) 3픽스 + URL 코퍼스(설계 장치 ②,
  `test/support/url-corpus.ts`, 총 38케이스) 완성. 이후 이 존 변경은 코퍼스 전체 통과가 머지 조건.

Assisted-by: Claude Fable 5
