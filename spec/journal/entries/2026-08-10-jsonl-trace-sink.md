# 2026-08-10 — JSONL trace writer를 엔진 어댑터로 이전 (브랜치 `feat/160-jsonl-trace-sink`, #160)

## 무엇을

러너(`team-poem/cairn-desktop`)의 `packages/trace/src/jsonl-sink.ts`를 엔진의
`packages/harness/src/adapters/sinks/jsonl.ts`로 옮김 — `reporters/`의 형제.
`index.ts`에서 `JsonlTraceSink` export(추가만 하므로 minor). 포맷 변화 0.

근거는 스펙 한 줄(`spec/core/trace.md` §One line): *"the live stream and the stored trace are
two serializations of the same model"* — 둘 중 하나만 엔진이 싣고 있으면 저장은 임베더마다
재구현되고, 그 순간 "저장된 트레이스"가 하나의 포맷이기를 그만둔다.

러너 쪽 모듈은 애초에 이 이동을 위해 격리돼 있었음(의존성 `cairn-engine` 하나 + node 빌트인,
파일 상단에 ISOLATION RULE 명시) — 그래서 재작성이 아니라 파일 이동.

## 유지한 동작 4가지 (러너가 실전에서 기댄 속성들)

- **sink는 절대 throw하지 않는다.** 트레이스는 증거지 제어 흐름이 아니다 — 기록이 판정을
  바꾸면 안 됨. `emit`은 버퍼링만 하고 삼킨다.
- **실패는 숨기지 않고 센다.** `failures` 공개 — 잘린 트레이스가 깨끗한 트레이스로 읽히면 안 됨.
- **경로는 헤더 자신의 `runId`에서 나온다**(생성자에 주는 건 `resolvePath` 함수).
  `startTrace`가 헤더를 동기로 쏘므로 반환 전에 `runId`/`path`가 정해짐 — 파일명과 헤더가
  불일치할 여지 자체를 없앰.
- **쓰기는 동기 `emit` 뒤의 직렬 큐에서.** 포트가 sync fire-and-forget이라 append 순서 보장이
  필요하고, 기다리는 건 `close()` 하나뿐.

`events` 배열(호스트가 방금 쓴 파일을 다시 읽지 않고 프로젝션하도록)은 러너 서버가 쓰고
있어 그대로 가져옴 — 대신 "긴 스위트면 전부 들고 있는다"는 비용을 주석에 명시.

## 스코프

- **In**: sink + 테스트. **Out**: reader·projection은 러너에 남는다 (§Model: *"presentation
  builds trees, the contract doesn't"*).
- **`attachment` 필드는 이 PR에 없다.** #160 코멘트에서 순서 합의 — sink 먼저, id 스킴은
  별도 작은 PR. 포맷 무변화라 러너가 즉시 자기 사본을 버리고 엔진 것을 import 가능.
- 합의된 id 스킴 방향(다음 PR): id는 `seq`에서 파생(고유·전순서 → heal의 두 프레임이
  last-write-wins로 뭉개지지 않음), 사이드카는 명명 규칙만으로 해석(`<runId>/<seq>.<ext>` 류,
  close 시점 매니페스트 금지 — 잘린 런도 이미 쓰인 attachment는 전부 읽혀야 함),
  한 이벤트가 여러 attachment를 가질 수 있게 되면 두 번째 카운터 대신 `<seq>-<k>` 접미사.

## 검증

- 신규 테스트 5개(`test/adapters/sinks/jsonl.test.ts`): 헤더가 정체성/경로를 준다 ·
  파일 순서 = seq 순서 = `events` 순서 · 헤더 전 이벤트는 버려지지 않고 대기 ·
  `resolvePath` throw를 삼키고 센다 · 디렉터리 자리에 파일이 있어 쓰기가 실패해도
  런은 모른 채 계속되고 `failures`만 오른다.
- 전체 401/401 · typecheck · build 그린.
- 브라우저 엔트리(`browser.ts`)에는 export하지 않음 — `node:fs` 의존이라 #156의 재발 방지 대상.

## state 변화 (머지 후 develop에 반영할 것)

- #160 sink 이전 완료(리뷰 대기). trace 트랙: 계약(#140) → provenance(#142/#144) →
  방출(#143/#155) → **저장 직렬화(#160)**. 남은 open은 attachment id 스킴 하나.
- 러너는 머지 후 자기 `jsonl-sink.ts`를 지우고 `cairn-engine`의 것을 import (포맷 동일).
