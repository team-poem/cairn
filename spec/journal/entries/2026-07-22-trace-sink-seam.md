# 2026-07-22 — trace 이벤트 sink seam 구현 (브랜치 `feat/trace-sink`, #143)

## 무엇을

`spec/core/trace.md` 계약을 엔진이 실제로 방출하게 함 — #138 스레드의 "the real close".

- **`TraceSink` 포트** (`ports.ts` 7번째 인터페이스, 불변식 #2): `emit(event): void`,
  동기 fire-and-forget. 엔진이 인라인 호출하고 **throw는 삼킨다** — 트레이스는 증거지
  제어 흐름이 아니므로, 죽은 sink가 판정을 바꾸면 안 됨. IO 하는 sink는 내부 버퍼링.
- **`Tracer`/`TraceScope`** (`core/trace.ts`, 포트 아님 — 내부 봉투 도장기): seq 단조
  증가·ts 스탬핑·`runId`, `startTrace()`만이 생성 경로라 **seq 0 = 헤더가 구조적으로 보장**.
  `scope(caseRef)`는 평평한 상관관계(caseRef 스탬프)만 — containment 없음, seq 카운터 공유.
- **방출 지점**: discover `action`/`gate`(policy·ambiguity·parse-retry·grounding drop —
  `deriveAssertions`에 `onDrop` 콜백 추가) · pipeline `step`/`heal(layer: step)`/`assertion` ·
  run.ts locator-heal 이벤트 + bare 모드 자체 트레이스(암묵 케이스) + outcome-heal
  재발견을 `tracePhase: "heal"`로 · suite 헤더/`case-start`/`case-end`/`freeze`/`run-end`.
- 기존 콜백(`onStep`/`onCase`/`onHeal`)은 그대로 — sink는 additive. sink 미지정 시
  Tracer 자체가 안 만들어져서(`scope?.emit`) 비용·동작 변화 0.

## 결정

- **freeze 이벤트는 suite가 쏜다** — payload의 `caseHash`가 suite 개념이라(§2 패턴≠데이터)
  코어는 끝까지 모름. `store.freeze`를 호출한 쪽이 이벤트도 소유.
- **스펙 addendum 2건** ("Decided in implementation (#143)"로 문서화, **solp721 리뷰 대기**):
  outcome-heal 재판정 assertion을 `phase: heal`로 · `done` 결정을 `action` 이벤트로.
- **attachment 필드는 v1 미방출** — id 스킴이 아직 open이라 의미가 바뀔 필드는 부재가
  낫다. 스킴 확정 시 additive하게 추가. 스크린샷은 기존 `onStep`으로 호스트 도달.
- grounding drop 보고는 플랜의 4곳이 아니라 6곳 — 기본 grounding으로 커버되는
  `navigated`/`no-failed-requests`/`no-console-errors` 제안은 해당 기본이 **성립 안 했을
  때만** drop으로 보고(진짜 드랍만 트레이스에, 정상 grounding은 침묵이 맞음).

## 검증

- 신규 테스트 24개(Tracer 8 · discover 6 · run 7 · suite 3), 전 태스크 red-first.
- 전체 394/394 · typecheck · build 그린.

## state 변화 (머지 후 develop에 반영할 것)

- #143 구현 완료(리뷰 대기) — 엔진이 trace 계약 스트림을 방출. addendum 2건은 PR에서
  solp721 확인 필요.
- #138 디스커션은 solp721이 스트림 확인하면 닫을 수 있음 ("I'll keep this open until the
  engine emits the stream for real" 조건 충족).
- 남은 오픈: attachment id 스킴(계약 문서 Open 그대로) · stored-trace 파일 sink 구현체
  (별도 작업 — seam 위에 어댑터로).
