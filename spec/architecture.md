# cairn 아키텍처 불변식

cairn은 자연어 의도를 브라우저 동작으로 옮기고, 수집한 증거로 결과를 판정하는
QA 에이전트다. 전체 설계는 `docs/design.html`. 이 문서는 **코드가 반드시 지킬
불변식**만 담는다.

## 구조
- 실행 본체 = 파이프라인: **Context → Plan → Execute → Judge → Report.**
- 모노레포: `packages/harness`(코어) + `packages/qa`(앱).

## 불변식 (PR에서 위반 금지)

1. **패턴 ≠ 데이터.** `packages/harness`는 특정 도메인·환경의 코드·데이터·커넥터에
   의존하지 않는다. 환경별 동작은 인터페이스 구현(플러그인)으로만 주입한다.
2. **확장은 인터페이스로만.** 새 동작은 다음 인터페이스를 통해 추가한다 —
   `ContextProvider · Planner · Driver · SkillStore · Critic · Reporter`.
   파이프라인 단계 안에 분기를 직접 박지 않는다.
3. **루프는 탐색에서만.** 에이전트 루프(관찰·행동·적응)는 *처음 보는 앱을 탐색*할
   때만. 정의된 시나리오의 실행은 파이프라인이다.
4. **재생은 결정적.** 굳힌(freeze) 시나리오의 재생 경로에는 LLM이 없다.
   LLM은 (a) 새 시나리오 탐색, (b) 깨진 스킬 복구(self-heal)에서만 호출한다.
5. **모델·드라이버 비종속.** 특정 LLM/브라우저에 코어가 하드 결합하지 않는다.
   기본 드라이버는 Chrome DevTools MCP, 교체 가능(Playwright 등).
6. **의존 방향.** `qa → harness` 한 방향. `harness`는 `qa`를 import하지 않는다.

## 코어 수정 시 체크
- [ ] harness가 특정 도메인·환경 코드를 import하지 않는가
- [ ] 새 동작을 인터페이스로 넣었는가 (단계에 직접 분기 X)
- [ ] 재생 경로에 LLM 호출이 없는가
- [ ] 의존 방향(qa → harness)이 유지되는가
