# 2026-09-03 — README를 짧은 랜딩 페이지로 바꾸고 가이드를 docs/guide.md로 이동 (#187)

- **브랜치:** `docs/readme-landing-style` (PR #188, `develop` 대상)
- **배경:** README가 470줄짜리 튜토리얼이 됐다. go-acme/lego와 golangci-lint의 README처럼
  로고·태그라인·한 문단 소개·배지·Features·Installation·Usage·Documentation으로 끝나는
  랜딩 페이지 형식으로 바꾸고, 자세한 내용은 문서로 링크한다.
- **구현:**
  - `README.md`를 그 형식으로 다시 썼다. lego의 DNS provider 표에 대응하는 **LLM backends 표**를
    두고, 미지원 모델은 `LlmClient` 포트 구현 또는 이슈로 안내한다.
  - 기존 README의 상세 내용(CLI 워크스루·임베드·suite·explore·skill 파일 형식·trace·self-heal·
    확장 포인트·FAQ·컨벤션·구조·상태)은 새 파일 `docs/guide.md`로 옮겼다. 내용은 그대로,
    문체만 손봤다.
  - 두 파일 모두 산문의 em-dash(—)와 세미콜론을 없앴다. TypeScript 스니펫의 문장 끝 세미콜론도
    뺐다. CLI 플래그의 `--`는 그대로다.
  - npm 페이지용 `packages/harness/README.md`는 별도 파일이라 건드리지 않았다.
- **검증:** grep으로 두 파일에 `—`와 `;`가 0개임을 확인했다. README의 상대 링크와 앵커가 모두
  존재하는 파일·헤딩을 가리킨다. 코드 변경이 없어 typecheck·build·test는 N/A.
- **state 변화:** 없음. 문서 구조만 바뀌었다(README = 랜딩, docs/guide.md = 사용자 가이드).
