# 2026-07-03 — discover 모듈 분리 · 디스패치 통일 · 테스트 트리 분리

- **브랜치:** `refactor/discover-structure`
- **디스패치 통일(불변식 #2):** `applyDecision`의 거대 switch가 `BuiltinStepHandler`와 같은 지식을 중복(액션 추가 시 5군데 동기화, never 가드 없음) → `decisionToStep`(순수 Decision→Step 매핑, never 가드) + 실행은 재생과 같은 `BuiltinStepHandler`로. discover·replay·step-heal이 한 실행 경로 공유.
- **모듈 분리:** 600줄 `core/discover.ts` → `core/discover/{index(루프)·prompt(LLM 표면)·decision(결정→실행)·capture(스텝 expect)·grounding(freeze 단언)}`. index가 공개 표면 재수출(외부는 import 경로만 변경).
- **테스트 트리 분리:** 콜로케이트(.ts 옆 .test.ts) → **`test/`가 `src/`를 미러링**. 공용 더블(ScriptedLlm·StubDriver)은 `test/support/doubles.ts`. 그랩백이던 `surgical-heal.test.ts` 해체(재생 검증→`test/run.test.ts`, 캡처→`test/core/discover/capture.test.ts`). tsconfig: typecheck=src+test, build=src만.
- **검증:** typecheck·171 테스트(18파일)·build OK·dist에 테스트 미포함.
- **state 변화:** 없음(내부 구조만, 동작 불변).
