#!/usr/bin/env bash
# PreToolUse(Write|Edit): remind the agent of the spec that governs the path it is editing.
# Non-blocking (exit 0).
input=$(cat)
fp=$(printf '%s' "$input" | grep -oE '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/')

case "$fp" in
  *packages/harness/*|*packages/qa/*)
    msg="REMINDER: editing packages/. Hold the spec/architecture.md invariants — pattern is not data / extend through interfaces only / the loop belongs to discovery / replay is deterministic and calls no LLM / the dependency direction is qa to harness." ;;
  *)
    exit 0 ;;
esac

# Modern Claude Code injects this as additionalContext; an older one ignores it harmlessly.
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}\n' "$msg"
exit 0
