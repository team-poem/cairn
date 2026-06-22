#!/usr/bin/env bash
# PreToolUse(Write|Edit): 수정 경로에 맞는 spec을 에이전트에 상기시킨다. 비차단(exit 0).
input=$(cat)
fp=$(printf '%s' "$input" | grep -oE '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/')

case "$fp" in
  *packages/harness/*|*packages/qa/*)
    msg="REMINDER: packages/ 코드 수정 중. spec/architecture.md 불변식 준수 — 패턴≠데이터 / 인터페이스로만 확장 / 루프는 탐색만 / 재생은 결정적(LLM 금지) / 의존방향 qa→harness." ;;
  *)
    exit 0 ;;
esac

# 모던 Claude Code: additionalContext로 주입. 구버전은 무해하게 무시됨.
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}\n' "$msg"
exit 0
