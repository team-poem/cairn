# 2026-09-08 — 분류 신호를 문자열에서 필드로 (#212)

- **브랜치:** `fix/212-structured-failure-signals`.
- **문제:** #173의 분류기가 사람용 `detail` 문자열을 정규식으로 읽었다. PR #211 리뷰 11건이 전부 거기서 나왔고
  (페이지 텍스트 속 단어, 도착 순서로 이어붙인 상태, 첫 실패만 적는 가드, 전송과 비활성 버튼을 같은 봉투에 싼 MCP)
  앵커·파싱으로 막았지만 문구 하나 바뀌면 조용히 풀리는 구조였다.
- **변경:** 신호를 아는 자리에서 필드로 싣는다. `AssertionResult.statuses`(critic이 본 상태 전부, 대기 0 포함),
  `AssertionResult.reason`(`judge-failed` | `no-handler`), `Verdict.failClosed`(`no-assertions` | `all-vacuous` |
  `blocked` | `truncated`), `ExecutedAction.errorKind`(`resolution` | `post-condition` | `timeout` | `transport` |
  `handler`). 에러 종류는 던지는 자리에서 `stepError(kind, msg)`로 — Error에 평범한 `kind` 속성이라 외부 드라이버가
  import 없이 던질 수 있고 `errorKindOf`가 구조적으로 읽는다. Chrome 드라이버가 자기 MCP 봉투를 스스로 판정
  (`net::ERR_`·`ECONN*`·`Target closed` → transport, 나머지는 미분류 = 페이지 쪽). `finalizeVerdict`의 `incomplete`는
  문자열(=blocked) 또는 `{ kind, reason }`. `classifyFailure`에 정규식 0개. 두 엔트리에서 `stepError`·`errorKindOf` export.
- **미분류 throw = script.** 아무것도 말하지 않으면 시끄러운 쪽.
- **PR #213 리뷰:** 봉투에 페이지 텍스트가 들어오는 길이 다이얼로그 하나인데, MCP는 `# Open dialog` 블록을 앞에
  붙일 뿐 아니라 에러 줄 자체에 다이얼로그 메시지를 반복한다(`A dialog is open (confirm: <페이지 텍스트>)`). 문구 앵커로는
  못 막는다 — 다이얼로그 차단 모양(`isDialogBlocked`)을 전송 검사 **전에** 인식해 미분류로 돌린다. 연결은 멀쩡하고
  다이얼로그가 동작을 막았을 뿐. `hover`는 `callAccepting`을 안 타서 그대로 표면화되므로 드라이버 통과 회귀 테스트.
- **2차 검증(throw 자리 전수 + puppeteer/chrome-devtools-mcp 1.3.0 실제 문구 대조)에서 고친 것:** (1) MCP SDK가 전송이
  in-flight 호출 중에 죽으면 봉투 없이 raw reject(`MCP error -32000: Connection closed`, `Not connected`)라 미분류였다
  → `call()`이 잡아 transport(#88의 그 순간). (2) 봉투 판정을 `mcpToolError`로 빼고 puppeteer 실제 문구에 앵커
  (`Protocol error (…): Target closed`, `Session closed. Most likely`, `Could not find Chrome`, `Failed to launch`) —
  `Target closed`·`Protocol error` 맨 토큰은 다이얼로그 메시지(봉투에 페이지 텍스트가 들어오는 유일한 길)와
  `Cannot find context`(앱이 호출 중 이동한 것, 기계 아님)에 걸렸다. (3) 변이에 안 잡히던 신호 셋(LlmCritic
  `judge-failed`, `toVerdict` `failClosed`, 봉투 판정)에 빨간 테스트. 남긴 것: 로케이터 heal 중 LLM이 죽으면
  원인(`resolution`)의 종류를 유지 — 타겟이 안 풀린 사실은 그대로고 LLM 장애는 수리를 막았을 뿐.
- **안 한 것:** `assertionPayload`(트레이스)에 `statuses`·`reason` 싣기 — additive라 다음 헤더 범프 때. #197은 이
  필드들을 그대로 읽으면 된다.
- **병렬 검증에서 고친 것:** (1) 테스트 파일 재작성 뒤 typecheck를 안 돌려 `criteria`(→`criterion`) 오타로 CI가
  빨갰을 것 — vitest는 타입을 안 본다. (2) 트레이스 `assertion`·`step` 이벤트와 `StepProgress`에 새 필드가 없어
  트레이스만으로 분류를 재현 못 했다(`case-end`엔 이미 새는 채) → 실어서 1.4→1.5. (3) 통과한 `request-status`에도
  `statuses`를 실어 #197이 색 무관하게 한 필드를 읽게. (4) 커스텀 Driver 작성자가 `stepError`를 알 길이 없었다 →
  `ports.ts` Driver 계약과 guide "Extend it"에 한 문장. (5) `finalizeVerdict(v, string)`은 이제 무조건 blocked —
  외부 호출자가 잘림 사유를 문자열로 넘기던 경우 의미가 바뀜(객체 형태로).
- **검증:** 분류 단위 10 + 신호 생성 5(실제 critic으로 amazon의 재현 3건 포함) + 종료코드 2 + 실제 재생 3(FakeDriver가
  `resolution`으로 타입). 고정 객체 테스트 2곳 갱신(#195 헬퍼 테스트, 핸들러 없는 스텝). typecheck·build·
  check:boundaries·전체 테스트·`test:consumer`(실제 Chrome).
- **상태 변화:** #212 종결. 남은 슬레이트 = #196·#197·#198(설계) · #171(amazon 제안) · #174·#175.
