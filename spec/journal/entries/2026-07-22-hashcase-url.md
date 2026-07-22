# 2026-07-22 — hashCase에 시작 URL 편입 (#131)

- **브랜치:** `fix/131-hashcase-url` (develop = 2.6.0行).
- **버그:** `hashCase`가 `intent`/`expect`/`assertions`만 지문 — 그런데 discover는 `url ?? baseUrl`을
  `steps[0] = goto`로 얼리므로 URL은 재생 내용에 직접 영향. 케이스 URL만 바꾸면 캐시가 정확 매치로 통과해
  **낡은 타겟으로 조용히 재생**(staleness 체크가 막으려던 바로 그 부류의 누출).
- **수정:** 해시 재료에 **유효 시작 URL**(`c.url ?? baseUrl`) 편입 — 케이스 URL 리포인트와 suite `baseUrl`
  변경(url 없는 케이스) 둘 다 stale로 읽힘. `hashCase(c, baseUrl?)` additive 시그니처, 호출부 3곳(staleness
  체크·freeze 스탬프·heal 재스탬프)에 `ctx.baseUrl` 전달. `id`/`maxSteps`는 계속 제외(파일 키/스텝 캡).
- **일회성 비용(정직):** 기존 frozen skill의 해시는 URL 없이 계산된 것 → 업그레이드 후 첫 실행에서 케이스당
  1회 재발견 후 새 해시로 재동결(false-stale, 안전 방향 — 해시 없던 skill의 기존 규칙과 동일).
- **검증:** 재현 테스트 2건(URL 리포인트 → 재발견 + 새 goto 확인 · baseUrl 변경 → url 없는 케이스 stale) +
  전체 396/396 · typecheck 클린.
- **state 변화:** #131 해소, 2.6.0行 편입.
