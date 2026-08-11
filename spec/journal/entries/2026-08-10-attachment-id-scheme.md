# 2026-08-10 — attachment id 스킴 확정 + 방출 (브랜치 `feat/160-attachment-id`, #160)

`feat/160-jsonl-trace-sink`(PR #161) 위에 쌓인 후속. #160 스레드 합의대로 **sink 먼저, id 스킴 별도 PR**.

## 결정 (스레드 합의를 코드로)

- **id = 그 이벤트 자신의 `seq`.** `(caseRef, stepRef)`가 못 하는 걸 `seq`가 함 — heal이 스텝을
  다시 돌리면 같은 `stepRef`에서 프레임이 둘 나오는데, 참조 상관관계로는 하나가 다른 하나를
  덮는다(뷰어엔 괜찮고 감사에는 틀림). 문법은 `<seq>`, 한 이벤트가 attachment를 여럿 갖게 되면
  `<seq>-<k>`(이벤트 **안에서** 접미사 — 두 번째 카운터 만들지 않기).
- **id는 Tracer가 찍는다.** `seq`가 봉투의 것이므로 id도 봉투의 것 — 호출부는 **바이트만** 넘기고
  id는 만들지 않는다(`tracer.emit(event, dataUrl)`).
- **사이드카는 명명 규칙만으로 해석. 매니페스트 없음.** 트레이스 파일명에서 확장자를 뗀 디렉터리
  (`runs/<runId>.jsonl` → `runs/<runId>/<seq>.png`)에 **도착하는 즉시** 한 파일씩 쓴다.
  close 시점에 쓰는 인덱스가 있으면 잘린 런에서 최악의 실패 모드가 나옴 — 디렉터리 목록이 곧 인덱스.
- **바이트를 저장하지 않는 sink에는 ref도 안 준다.** `TraceSink.attach`는 optional. 없으면
  스크린샷을 **애초에 찍지 않고**(sink 부재 시 이벤트를 안 만드는 것과 같은 자세) 필드도 안 붙는다 —
  해석 불가능한 ref는 ref 없음보다 나쁘다.

## 무엇을

- `ports.ts`: `TraceAttachment { id, data }` + `TraceSink.attach?()`. data는 data URL
  (`Driver.screenshot()`이 주는 형태) — 직렬화마다 처분을 정한다(저장은 사이드카, 라이브는 그대로 전달).
- `core/trace.ts`: `TRACE_VERSION` **1.0 → 1.1**(§Versioning의 additive = minor),
  `step.payload.attachment?: string`, `Tracer.emit(event, attachmentData?)`,
  `Tracer/TraceScope.acceptsAttachments`. **바이트 먼저, 그 다음 줄** — 중간에 끊기면 참조 없는
  사이드카(무해)가 남지, 해석 안 되는 ref가 남지 않는다.
- `core/pipeline.ts`: 스크린샷 캡처를 step 이벤트 **앞**으로 옮기고 `onStep`과 공유 —
  캡처 1회, 소비자 2곳. `captureScreenshots && (onStep || trace.acceptsAttachments)`일 때만 찍는다.
- `adapters/sinks/jsonl.ts`: `attach()` 구현 + `attachmentsDir`. data URL 디코드(base64/텍스트),
  media type → 확장자(모르면 서브타입, 그것도 아니면 `bin`). 못 쓰면 `failures`만 오르고 트레이스는 계속.
- `suite.ts`: `screenshots`를 `SuiteOptions`에 통과시킴 — 없으면 스위트 런에서는 attachment가
  구조적으로 안 나온다(감사 대상 트레이스가 나오는 곳이 스위트라 이건 스코프 안).
- `run.ts`: `screenshots` 주석만 갱신.

## 검증

- 신규 테스트 11개 (401 → 412), typecheck·build 그린.
  - Tracer: id = seq · heal 두 프레임이 **두 개**로 남음 · attach 없는 sink엔 ref 없음 ·
    scope 통과 및 step 이벤트에만 · attach가 throw해도 삼킴.
  - sink: 사이드카가 `<runId>/<seq>.png`로 앉고 목록만으로 해석됨 · close 못 한 런도 이미 쓴 건 읽힘 ·
    디코드 실패는 `failures` 1 + 나머지 이벤트 무사.
  - pipeline: sink가 바이트를 받으면 ref가 붙고 · 아무도 저장 안 하면 **스크린샷 자체를 안 찍고** ·
    onStep과 캡처 1회를 공유.

## state 변화 (머지 후 develop에 반영할 것)

- **`spec/core/trace.md`의 Open 항목 0개** — attachment id 스킴이 마지막이었고 #160에서 닫힘.
  헤더 버전 1.1. trace 트랙: 계약(#140) → provenance(#142/#144) → 방출(#143/#155) →
  저장 직렬화(#160/PR #161) → **attachment(#160, 이 브랜치)**.
- 러너는 자기 사이드카 스톱갭(`(caseRef, stepRef)` 조인)을 걷어내고 엔진 id로 갈아탈 수 있음.
