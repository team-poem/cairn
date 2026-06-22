# design — 포인터

cairn 전체 설계 문서는 **`docs/design.html`** (브라우저로 열기).

**한 줄 요약:** 처음 보는 앱을 탐색해 길을 찾고(discover), 성공 경로를 굳혀(freeze),
다음부터 결정적으로 재생(replay)하는 QA 에이전트. 판정은 실행·화면·로직 3층 증거.

코드가 반드시 지킬 불변식은 `spec/architecture.md`.
