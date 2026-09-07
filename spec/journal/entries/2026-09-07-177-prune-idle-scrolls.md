# 2026-09-07 — 헤매던 스크롤을 프리즈에서 뺀다 (#177)

- **브랜치:** `fix/177-prune-idle-scrolls`.
- **문제:** discover가 헤매며 한 스크롤이 그대로 얼어 매 재생마다 다시 걸린다. 꼬리 스크롤은 판정이 네트워크
  속도에 좌우되고 검증 내용을 화면 밖으로 밀어낸다. 그렇다고 요청 0개가 곧 무의미는 아니다 — 가상화 리스트는
  스크롤해야 다음 타겟이 a11y 트리에 뜬다.
- **규칙(이슈 그대로):** 스크롤 스텝의 요청 꼬리가 비었고(벤인 제외) **그리고** 다음 스텝의 타겟이 스크롤
  **직전 스냅샷**에 이미 있었을 때만 제거. 다음 스텝이 없는 꼬리 스크롤은 요청 0개면 제거. 타겟 없는 스텝
  (pressKey·waitFor·goto)이 다음이면 판단 불가라 유지. 연속 스크롤은 뒤에서부터 판단해 살아남은 첫 비-스크롤
  스텝과 대조.
- **구현:** 루프가 스크롤 결정일 때만 `OutcomeMark.elements`에 직전 스냅샷을 남김. `finish()`에서
  `assignStepExpects` **전에** `pruneIdleScrolls`가 steps/marks를 정렬 유지하며 제거. "있다"는 `describeAmbiguity`와
  같은 규칙(role 일치 + 이름 정확 일치)이라 드라이버의 substring locate보다 엄격 → 의심스러우면 유지.
  제거마다 `gate: idle-scroll`(stepRef = 원래 인덱스) 발행, `cairn discover`가 개수 출력. 트레이스 1.3 → 1.4
  (기존 gate 필드에 값 추가, minor).
- **병렬 검증에서 고친 것:** (1) `targetPresent`가 `nth ?? index`를 이름 매칭 위치로 써서, Chrome `locate`가 모든
  타겟에 찍는 `index`(같은 role 중 위치) 때문에 실제 페이지에선 role 첫 번째 요소가 아니면 절대 안 지워졌다 —
  `nth`만 본다. (2) disabled 요소를 "있다"로 쳤다 — 끝까지 스크롤해야 활성화되는 Accept는 스크롤 전에도 트리에
  있어 지워지고, 재생이 비활성 버튼을 눌러 빨개지고, heal이 같은 `discover`를 타 같은 스크롤을 또 지우는 무한
  루프 — disabled는 "없다". (3) `cairn discover`의 개수 출력이 `!provesAnAction` 블록 안에 있어 정상 프리즈에선
  안 찍혔다. (4) 뒤에서부터 판단한다는 규칙에 빨간 테스트가 없었다(전부-idle 세 스크롤 케이스 추가).
  (5) judgment.md 문단을 #203처럼 독립 절로, 이름 정체성 한계(가상화 창이 동명 다른 요소 위로 이동) 명시.
  (6) trace.md 버전 규칙에 "기존 enum 필드의 새 값 = minor" 추가.
- **amazon 리뷰(PR #210)에서 고친 것:** (1) 다음 스텝 하나만 봤다 — 스크롤의 DOM 상태는 같은 페이지의 뒤 스텝
  전부에 남는다(`scroll → click Filter(툴바) → click Message 87(스크롤해야 마운트)`에서 Filter만 보고 지움). 페이지
  이동이나 다음 살아남은 스크롤까지의 타겟 스텝 전부가 스크롤 전에 있어야 지움; 타겟 없는 스텝이 끼면 유지.
  (2) 동명·같은 role 중복은 `resolveTargetUid`가 #127로 거부하는데 presence는 true였다 — "드라이버보다 엄격"이
  이 부류에선 거짓. nth 없으면 같은 role 중복은 false. (3) `disabled`를 raw에서 읽었는데 `perceive` 훅이 바로 그
  상태를 고치라고 있다 — 존재는 raw, 활성은 perceived(`OutcomeMark.perceived`, 훅 있을 때만). (4) 벤인 필터가
  lazy 이미지와 API를 못 가르고 `resourceType`은 드라이버가 안 채운다 → 실제 앱의 꼬리 스크롤엔 대부분 안 걸림.
  안전한 방향이라 spec에 한계로 명시, 드라이버가 `resourceType`을 채우는 것을 후속으로. (5) CLI 줄이 고아 불릿 → 문장.
- **검증:** 단위 16(제거/지연로드 유지/벤인 무시/가상화 유지/타겟 없음 유지/꼬리 제거/연속/role·nth/스냅샷 없음)
  + discover end-to-end 5(정적 페이지는 빠지고 stepRef=1로 트레이스 · FakeDriver의 index 스탬프에도 빠짐 · 가상화는 남음 · scroll-to-enable은 남음 · perceive 훅이 disabled라 하면 남음).
- **상태 변화:** #177 종결. 2.9.0 슬레이트의 "작은 것" 셋(195·204·177) 완료. 남은 건 196·197·198(설계).
