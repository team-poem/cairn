# 2026-08-27 — #176: 이름이 겹칠 때 "페이지에 실제로 보이는" 후보로 해소

- **브랜치:** `fix/176-hit-test-duplicate-names` (develop 기준)
- **문제와 정정:** 이슈는 "동명 요소가 여럿이면 트리 순서 첫 번째를 고른다"고 적었지만 **같은 role
  중복은 이미 거부한다**(#127, `resolveTargetUid`). 살아남은 first-match는 **role이 서로 다른 경우
  하나뿐**이고, 이슈가 든 실패 형상(모달의 submit **button** vs 배경 nav **link**)이 정확히 그 경우라
  버그는 실재한다. 그리고 그 cross-role first-match는 실수가 아니라 의도다 — a11y 트리는
  `link "X"` 위에 `StaticText "X"`가 겹치는 래퍼 쌍을 일상적으로 만들고 둘은 같은 것을 클릭한다.
  그래서 "모호하면 거부"로 넓히면 평범한 링크 클릭이 전부 self-heal로 떨어진다.
- **구현상 제약:** MCP 텍스트 인터페이스에는 **uid→DOM 매핑이 없어서** "후보마다 히트테스트"를
  그대로는 못 짠다. 그래서 프로브가 요소가 아니라 **role만** 돌려주게 했다 — 그 이름을 가진 요소 중
  center-point 히트테스트에 닿는 것들의 role 집합을 받고, 그게 스냅샷 후보와 교차해 하나로 좁혀질
  때만 기존 role 좁히기(`resolveTargetUid(rows, {...target, role})`)에 태운다. 위치 정렬 문제가 사라진다.
- **적용 지점:** `resolveUid`(재생)와 `locate`(freeze) 양쪽이 `resolveVisible`을 통과한다. locate가
  고쳐지는 게 중요하다 — freeze 시점에 잘못된 role을 박제하면 재생은 결정적으로 계속 틀린다.
  모호하지 않으면 프로브를 아예 안 부른다(비용 0). 닿는 게 없거나·둘 이상이거나·스크립트가 실패하면
  현행 트리 순서를 그대로 둔다(fail-safe). LLM 없음 → 불변식 #4 유지, `Driver` 포트 변경 없음(#2·#5).
- **검증:** typecheck·build·465 테스트(+16). **실브라우저 확인**(claude-in-chrome, example.com에
  픽스처 주입): 모달+백드롭 상태에서 `{"roles":["button"]}`, 모달 제거 후 `{"roles":["link"]}` —
  가려진 배경 링크가 정확히 탈락한다. 이 확인 과정에서 **실제 버그를 하나 잡았다**: 스크립트를 템플릿
  리터럴로 조립하다 `\s`가 삼켜져 `/s+/g`가 나갔다(공백 정규화가 문자 "s"를 지웠을 것). 회귀 테스트로 고정.
- **메인테이너 리뷰(PR #181) → 프로브가 실제 클릭보다 엄격했다:** 드라이버는 chrome-devtools-mcp를 거쳐
  puppeteer `Locator`로 클릭하는데 **그건 먼저 스크롤한다**. 그리고 좁히기의 근거가 되는 a11y 스냅샷도
  뷰포트로 걸러지지 않는다. 그런데 내 프로브는 뷰포트 밖이면 "도달 불가"로 판정했다 — 즉 **접힌 화면
  아래의 올바른 버튼이 탈락하고 눈에 보이는 미끼 링크로 좁혀진다.** fail-safe는 "아무것도 도달 못 함"만
  덮고 "틀린 것만 도달함"은 안 덮었고, 그 role이 `locate`로 박제되면 `scoreTarget`이 0.7을 주므로
  weak 경고도 안 뜬다. 대응: 프로브 답을 **reachable / occluded / unknown**으로 쪼개고,
  **후보 중 unknown이 하나라도 있으면 좁히지 않는다**(가림이 실측된 경우에만 좁힌다).
  뷰포트 밖·크기 0·hit test 무응답은 unknown이다.
- **이름 읽기 누락:** `named()`가 `aria-label`·`title`·`textContent`만 봐서
  `<input type="submit" value="Continue">`가 **이름 없는 요소**가 됐다. 모달 제출의 흔한 형태다.
  input일 때 `value`를 읽게 했다(`roleOf`는 이미 처리하고 있었다).
- **실브라우저 재확인**(example.com에 픽스처 주입): 접힌 화면 아래 버튼 + 보이는 미끼 링크 →
  `{reachable:["link"], unknown:["button"]}`로 **좁히기 포기**, 모달+백드롭 대조군 →
  `{reachable:["button"], unknown:[]}`로 좁힘, `input[type=submit]` → 이제 이름이 잡혀 `button`. #176 close. 남는 한계 = 접근성 이름을 DOM에서 근사하므로(aria-label/title/textContent)
  a11y 트리 name과 어긋나면 프로브가 빈손이 되어 현행 동작으로 떨어진다. iframe 안 후보와 뷰포트 밖
  후보도 닿지 않는 것으로 본다.
