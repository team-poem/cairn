# 2026-08-27 — discover CLI: 버려진 행위 증명을 경고로 노출

- **브랜치:** `feat/cli-grounding-drop-warning` (develop 기준, PR #178과 독립)
- **문제:** grounding이 제안된 `request-status`를 드랍하면 그 사실이 **trace에만** 남는다. CLI로
  discover를 돌린 사용자는 "행위가 실제로 일어났다는 증명이 빠진 스킬"을 조용히 받는다.
  드랍은 fail-closed도 아니다 — 비항진 `navigated` 하나만 남아도 시나리오는 GREEN이라
  액션 없이 목적지에만 도달해도 통과한다. 코덱스 교차검증(PR #178 리뷰) 5번 지적.
- **구현:** 엔진 API는 안 건드렸다. `core/freeze.ts`에 `droppedProofReason(event)` 추가 —
  grounding 게이트 이벤트 중 제안이 `request-status`였던 것만 사유를 돌려준다(할루시네이션 드랍,
  `--semantic` 없는 `expect` 드랍 같은 일상적인 건 trace에만 남긴다). CLI는 `Tracer`에 인라인 싱크를
  물려 discover에 `trace`로 넘기고, 모인 사유를 #137 경고 블록 옆에 출력한다. freeze.ts를 고른 이유는
  이 파일이 이미 freeze 시점 CLI 경고(weakTargets·guessedKeyRuns)의 집이기 때문.
- **검증:** typecheck·build·454 테스트(+5, `droppedProofReason` 유닛). CLI 자체는 테스트 하네스가
  없어서 판별 로직만 순수 함수로 떼어 검증했다. 실앱 도그푸딩은 안 돌림(LLM+브라우저 필요).
- **메인테이너 리뷰(PR #180) → 경고 조건을 뒤집었다:** 트리거가 틀린 값을 보고 있었다. 메시지는 **프리즈**에
  대한 것인데 트리거는 **trace**를 보고 있어서 양방향으로 어긋났다 — 제안 둘 중 하나가 얼려졌는데도 경고가
  뜨고, 아무것도 제안되지 않아 증명이 없는 프리즈는 조용했다. #178이 첫 경우를 흔하게 만들었다(리뷰어 실측:
  형제 동사가 있는 코퍼스 30행 중 29행에서 충돌 가드가 발동하고, 그 전부가 method 묶인 체크를 얼린 상태).
  `provesAnAction(scenario)` — **살아 있는(비항진) `request-status`가 있는가** — 로 바꿨다. 읽기 전용
  플로우는 증명할 액션이 없는데도 경고가 뜨는데, 시끄러운 방향이라 그대로 두고 메시지에 명시했다.
- **문구 정정:** "할루시네이션 체크는 trace에만 남는다"가 **거꾸로**였다(본문·커밋·저널·docstring 전부).
  매칭되는 요청이 없어 드롭되는 그 케이스가 이 블록이 출력하는 **가장 흔한 줄**이다. PR #178 본문의 "Known limits" 2번 해소(노출까지 — drop이 fail-closed가 되는 건
  아니다). 근본 해결은 substring 매칭 대신 구조화 매칭으로 표현형을 바꾸는 별도 트랙.
