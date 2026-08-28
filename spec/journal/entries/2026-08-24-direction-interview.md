# 2026-08-24 — direction interview (ouroboros): refactor gate first

- 브랜치: (설계 세션 — 코드 변경 없음). 계기: 팀 대화(desktop 회의론, CLI/플러그인 피벗) + #168 디스커션.
- 방법: ouroboros interview 8문항, 문항마다 자문 6-lane(코드/웹/데이터/반론/단순화/아키텍처) fanout, seed-ready 3-lane 가드(closer/contrarian/gap-hunter) 통과. ambiguity 0.31 → 0.11.

## 결정 (인터뷰 확정)
1. **Desktop**: 별도 레포(cairn-desktop), lab-only 동결 — 기록만, 이번 사이클 엔지니어링 0.
2. **Heal 권한**: 플러그인(Claude)이 trace 소비→heal→re-freeze까지 자율 가능하되, **re-frozen diff는 사람이 코드 리뷰처럼 게이트**. 엔진 replay는 LLM-zero 유지, 판단 루프는 러너 소유.
3. **스토리지 코어 가치**: "이 frozen skill이 현재 case 정의에 유효한가(caseHash) + 마지막 green 버전 + re-freeze 계보". 라이브 앱 대비 staleness는 러너/replay 몫(스토리지 질문 아님).
4. **리팩터링 = 게이트, 먼저, amazon 소유.** 성공 = 검증 가능한 구조 규칙: ① cli.ts = 인자 파싱+포트 배선만 ② caseHash 유효성은 SkillStore 포트 뒤로(suite.ts에서 제거) ③ 의존방향 CI 기계 강제(dep-cruiser류, **트랙 첫 PR로 선행** — #156 선례) ④ #8 public-surface 예제 CI green. 패키지 분리는 3.x 후보로 유보. 체감 판정 기각.
5. **게이트 범위 = 파일 범위 하드**: packages/harness/src만 동결. bench/(dist만 import, 충돌 0)·docs·플러그인 스캐폴딩은 병렬 자유.
6. **계보 스토어 합격 바**: 포트 레벨 통합 테스트 — freeze → green 기록 → red 기록 → heal re-freeze → **스토어 디스크 재오픈** → 쿼리가 last-green caseHash + parent→child 체인 반환. green = case 단위, 원본 단언 기준, healed-pass는 diff 승인 후에만. v1은 suite 전용. 쿼리 배치(포트 메서드 vs 순수함수)는 트랙 내 design-review 항목.
7. **CLI**: 새 표면은 `cairn history <case>` 하나(계보 트랙과 동시 출고). 규칙: CLI 명령은 엔진/포트 기능 1:1 재사용만. --trace 플래그 안 함(소비자 없음).
8. **플러그인**: cairn-engine을 npm 의존성으로 **임베드**(runSuite + 자체 TraceSink, 새 엔진 표면 0). 성공 순간 = "/cairn:replay가 frozen suite 돌리고 사람이 raw JSONL 안 읽어도 스텝별 pass/fail + heal diff 제안".
9. **순서·오너(리팩터링 이후)**: 의도적 미정 — #168 코멘트로 팀이 정함. 각 트랙 내용 정의는 위 그대로 유지.

## state 변화 (develop 머지 후 반영)
- 다음 사이클 방향: "first-party 러너 + 로컬 웹 UI" → **리팩터 게이트(파일범위 하드) → {계보 스토어, 엔진 임베드 플러그인, #103 벤치} 순서 미정**으로 교체.
- desktop freeze 마커 추가 필요: "Desktop(별도 레포)은 lab-only 동결, 재개는 별도 결정."
- ouroboros 세션: interview_20260824_050054 (seed 생성 가능 상태로 종료).
