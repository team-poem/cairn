# design — 포인터

- **정본(에이전트용):** `docs/design.md`
- **시각 버전(사람용):** `docs/design.html`

**한 줄 요약:** 처음 보는 앱을 탐색해 길을 찾고(discover), 성공 경로를 굳혀(freeze),
다음부터 결정적으로 재생(replay)하는 QA 에이전트. 판정은 실행·화면·로직 3층 증거.
형태는 CLI 우선. 코드가 반드시 지킬 불변식은 `spec/architecture.md`.
