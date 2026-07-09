# 2026-07-09 — 커스텀 위젯 지각 갭: cairn 엔진 관점 정리 + 방향

- **브랜치:** `develop`(분석·저널) → 구현은 별도 브랜치. 실측 = 한 소비자 앱 임베드 도그푸딩(chrome-devtools 관측).
- **실측 발견:** 한 소비자 앱의 장바구니 체크박스가 커스텀 컴포넌트 — `<input>{display:none}` + `aria-checked` 없음 +
  접근성 이름 없음, **시각 선택 상태는 styled span 클래스에만.** `input.checked`는 항상 false(시각은 "전체 선택 (19)").
  소비자 선택 로직이 `input.checked`를 진실로 믿어 이미 선택된 걸 "미선택"으로 오판 → 클릭 → 되레 해제 → 진동.
- **핵심 전환:** 이건 특정 소비자만의 버그가 아니라 **cairn 엔진 질문**이다. cairn은 범용 QA 엔진이고,
  "커스텀/a11y-깨진 위젯이 있는 앱을 어떻게 지각·조작하나"는 1급 문제. 앞 세션들이 소비자 버그로만 위치시킨 게 오류.
- **두 축 분해(성격이 직교):**
  - **① 신뢰(trusted) 액션** — JS `.click()`(untrusted)은 controlled 컴포넌트에 안 닿고 CDP trusted 이벤트만 도달.
    이건 controlled 컴포넌트 쓰는 **모든 앱의 일반 성질**. cairn 드라이버 정상 클릭은 이미 trusted → 버그는 소비자가
    지름길로 JS 클릭 쓴 것뿐. **범용·이미 해결. 취약하지 않음.**
  - **② 상태 지각(perception)** — 진짜 갭. 시각 상태가 DOM/a11y에 안 드러남. cairn은 보조기술처럼 a11y 트리로
    지각하므로 **스크린리더가 막히는 바로 그 지점에서 막힘.** `input.checked`/fiber 깊이/해시 클래스로 우회 = 전부
    "안 보이는 걸 억지로 보는" 취약 땜빵(리디자인 한 번에 조용히 깨짐). ⚠ **이 부류는 "상태 부재"가 아니라 "상태를
    자신있게 틀리게 보고"라서 — 엔진이 a11y 트리만으론 자동 감지 불가**(확신에 찬 unchecked). 이게 설계상 한계.
- **원칙(공포의 정확한 봉쇄):**
  - 엔진/드라이버에 위젯별 DOM 해킹을 늘리지 않는다(슬롭 트레드밀). 대신 3층:
    1. **범용 드라이버** = trusted 액션 + a11y 지각. 표준 준수 위젯은 0의 노력.
    2. **소비자 주입 seam** = a11y 어기는 위젯은 소비자가 "이렇게 읽고 조작"을 주입(현재는 Driver `snapshot()` 래핑으로
       가능 — 소비자 드라이버가 이미 이 자리). 엔진 우회 해킹이 아니라 정식 확장. **비용은 정직히: a11y 깨진
       위젯은 소비자가 위젯마다 가르쳐야 함(엔진은 안 커지지만 소비자 어댑터는 커짐). 공포의 절반은 진짜.**
    3. **앱에 a11y 버그로 제기** = 진짜 픽스. 체크박스에 `role=checkbox`+`aria-checked` 넣으면 cairn·스크린리더 둘 다
       고쳐지고 어댑터 해킹이 0. **QA 툴이 이 결함을 짚은 것 자체가 산출물**(장애물 아님).
- **cairn 엔진 몫(리트머스 "다른 소비자도 원하나?" = YES, 커스텀 위젯 앱은 다 겪음):**
  - **trusted-input 계약** — Driver 포트에 명문화(레퍼런스 드라이버가 untrusted 지름길 금지). 작고 범용.
  - **약한 지각(weak-perception) 표면화** — 지각/조작 불가 컨트롤을 만나면 **조용히 추측 말고 경고**(약한 타겟 #14 ·
    추측 스텝 #61의 지각 버전). 단 sound하게 감지되는 부분류만; "확신에 찬 오보"는 감지 불가라 seam 필요.
  - **커스텀 지각/조작 어댑터 seam** — 소비자가 위젯별 읽기·조작을 1급 포트로 주입. **큰 추가 → 불변식 #7 규율대로
    실측+이슈 먼저.** 오늘 실측이 그 첫 근거.
- **구현 완료 (#132 / PR #133, develop 머지):**
  - **Driver 포트 계약** — trusted input(상호작용은 trusted 이벤트, synthetic JS click 금지) + a11y-native 지각 명문화.
  - **`perceive` seam**(`DiscoverOptions`/`RunScenarioOptions.perceive`, `PerceptionAdapter`) — 소비자가 스냅샷 상태를
    교정(outcome-heal 재탐색에도 관통). 자기 Driver 있으면 `snapshot()` 래핑이 일반 seam, perceive는 레퍼런스 드라이버 편의.
  - **role 없는 클릭 리전 승격**(레퍼런스 드라이버) — 두 번째 실측(스토어 상품카드 = `<div>`+onClick, role/name 없음 →
    LLM이 못 보고 이름 함정에 끌려 하단 스크롤·헤맴)이 드러낸 발현. `cursor:pointer` **+ inline/property onclick**인
    roleless·non-native 요소의 라벨을 clickable로 노출. 핸들러 요구가 오탐 제거+중첩제거 동시 해결. region당 **가장 긴 텍스트**
    (배지/브랜드 선행 collapse 방지), 라벨 role은 raw StaticText 유지(클릭 버블), 승격 role 에코도 resolve. cap·gate·raw변경시만 재probe.
  - **층 분리(확정):** cairn = inline/property 핸들러(범용, 바닐라/inline 안전망) · 소비자 드라이버 = React 위임 등
    프레임워크 핸들러(앱-특정, 불변식 #1). 상보적, 안 겹침.
- **미구현(이슈로 남김):** "약한 지각 경고"의 confidently-wrong 부류(a11y가 상태를 자신있게 틀리게 보고)는 자동 감지 불가 →
  seam(perceive)이 답. 감지 가능한 sound 신호가 실측되면 그때.
- **state 변화:** 지각 축(동사 축 #7과 직교)을 엔진 관심사로 인식 + perceive seam·클릭 승격이 2.5.0行에 편입.
