# 2026-09-10 — PR #221 후속 리뷰 계약과 #226 통합

- **브랜치:** `codex/198-perception-design`. `7ec42a4`에 대한 solp721의 후속 리뷰를 다뤘다.
- **승인:** 새 회귀 20개를 개별 RED로 확인한 계획을 사용자에게 제시했고 진행 승인을 받았다. #226의 목록 생략 기대 두 assertion을 현재 목록 포함/생략 문구 없음으로 바꾸는 범위를 승인받았다. 시스템 프롬프트의 전체 문자열을 고정한 기존 테스트 두 개는 별도 정확한 문구 diff를 제시한 뒤 기대 문자열 갱신 승인을 받았다. 기존 테스트의 나머지 줄은 보존했다.
- **#226:** `origin/develop`의 `01378e3`을 통합했다(`c2430bb`). discover/explore의 `prevRender` 제거와 호출 시그니처 충돌을 함께 해결하고 upstream stateless-listing 테스트를 유지했다. `state.md`를 수동 편집하지 않았다.

## 바뀐 동작

1. **재시도 캐시:** verbose resolution 결과를 함수 안에만 두어 다음 compact 기반 선택과 custom-select watermark에 섞이지 않게 했다. 독립 검토에서 Missing 탐색 중 Save 노드가 교체되는 경계도 재현했다. 최종 실패 시 compact cache를 비워 이후 클릭이 새 UID를 캡처하게 보완했다. 성공한 verbose-only 컨트롤의 옵션 비교는 유지한다.
2. **Step-heal 예산:** 모델 요청 직전에 시도를 예약하고 성공 이력과 분리했다. 모델 오류·잘못된 응답·policy 거부·dispatch 실패도 요청 예산을 쓴다. 기본값 5는 근거 없이 높이지 않았다. 일반 pipeline은 첫 미복구 divergence에서 멈추므로, 실패한 step-heal 예산 누수의 정확한 재현은 같은 healer의 반복 호출/재사용이다.
3. **Perception/binding:** 공백·대소문자만 다른 이름은 허용하되 원래 이름·role·ref로 policy/dispatch/freeze한다. 임의 이름·role 변경은 거부하고, 두 루프가 제한된 재관측으로 복구하거나 truncated 종료한다. 잘못된 ref를 JSON 문법 오류로 안내하지 않는다. 독립 검토에서 숫자 text의 TypeError를 재현하고 문자열 아닌 설명도 typed binding 거부로 처리했다.
4. **프롬프트:** 공유 시스템에 실행 가능한 ref-only action 예제와 동반 설명 일치 규칙, clickable/active-popup 측정 사실의 의미·효과 미보장을 추가했다. ref 표에도 잘림 안내를 붙이고 페이지 데이터를 최종 action instruction 앞에 배치했다. surgical-heal에도 공통 스키마를 전달한다.
5. **Chrome ref 연속성:** 같은 역할 후보군의 원래 DOM 객체를 유지하고 관련 노드·이름·role·순서 변화는 거부한다. 무관한 clock/spinner/image 변경은 fresh AX의 역할·이름 및 DOM 객체 순서로 재검증한다. compact가 버린 verbose-only peer의 UID가 새로 발급되어도 UID 문자열이 아닌 원래 DOM 동일성을 확인한다. mutation record는 4,096개로 제한하고 초과 시 disconnect/해제한다.

## 검증

- 승인한 새 20개 + 이전 10개가 모두 체크됐으며 헤더와 테스트 본문이 계획 원문과 일치한다.
- `npm test`: 엔진 **1,130개**, 루트 테스트 **69개** 통과.
- `npm run test:browser -w cairn-engine`: 실제 Chrome **21개** 통과. 기존 교체/구조/accessible-value/프레임 보호 테스트도 유지했다.
- 타입 검사, 빌드, 의존 경계 검사 통과.
- 실제 MCP 1.3.0과 격리한 Chrome: exact selection → freeze → 새 Driver replay, 무관한 clock/spinner/decorative 변경 허용, selected/cohort drift와 full-only ref·capture 실패 거부 확인. 같은 DOM peer의 UID가 `20_8`에서 `22_5`로 재발급되는 경우도 성공했다. 실제 LLM 호출은 없다.
- `/tmp/cairn221-phase2-audit.py`: 통합 기준 기존 테스트 파일 **75개**가 정확히 승인한 예외 외에는 바뀌지 않았고, 승인한 **30/30** 테스트가 원문 그대로 존재함을 확인했다.
- 원래 `gate.sh`도 실행했다. 전체 suite는 통과했지만 승인한 두 시스템 snapshot 줄을 수정으로 보고해 exit 1이다. git-excluded 계획은 gate의 commit diff에서 보이지 않아 `0 this run`으로 표시된다. 하네스를 바꾸거나 gate 통과를 주장하지 않으며 위 별도 검사로 예외 범위와 실제 테스트 존재를 검증했다.
- 상세 로컬 로그: `/tmp/cairn221-phase2-final-{tests,browser,typecheck,build,boundaries}.log`, `/tmp/cairn221-phase2-mcp-smoke.log`, `/tmp/cairn221-phase2-native-gate.log`. 경계 재현: `/tmp/cairn221-normalization-type-smoke.mjs`, `/tmp/cairn221-cache-replacement.ts`.

## 남은 한계와 state 변화

승인된 후속 계획은 20/20 완료했고 #226 통합도 끝났다. 다만 모든 리뷰 우려가 무조건 사라졌다고 주장하지 않는다.

- fresh AX 두 번 모두에 계속 DOM 변경이 겹치면 보수적으로 ref를 거부한다. 일부 candidate-tag/ancestor 검사도 무관한 변경을 거부할 수 있다. 계속 변하는 모든 페이지에서의 진행을 보장하지 않는다.
- 기존 text/nth 타깃은 capture pool을 저장하지 않으므로 compact-first/full-tree fallback의 순번 의미 차이가 남는다. 기존 frozen 호환성을 유지했으며 새 exact ref의 compact re-anchoring 보장을 모든 과거 순번 타깃에 소급하지 않는다.
- compact에 없는 full-only exact ref는 여전히 freeze를 거부한다. 별도 영구 locator 전략이 필요한 영역이다.
- `run.ts` 옵션 전달 범위, 모델 판단 품질 검증, PR 머지·릴리스는 수행하지 않는다.

## Reflect

- **Brain:** 변경 없음. 루트 하네스 쓰기 제한을 준수했다.
- **Skills:** 변경 없음.
- **Structural:** 요청 예산 예약과 mutation 기록 상한을 구현에 넣었다. 스냅샷 예외는 정확한 문자열 비교로 검증했다.
- **Todos:** 루트 추가 없음. 지속적 변경과 legacy pool identity 한계는 위와 shipped perception 명세에 남겼다.
