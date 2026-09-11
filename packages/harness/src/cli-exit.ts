import type { FailureClass, Verdict } from "./index.js";

/**
 * Exit codes a CI job can branch on (#173). 0 pass · 1 the flow broke (block) · 3 the script
 * aged (re-discover) · 4 the environment: neither the app nor the script — the browser or judge
 * died, the host's setup is wrong, the app refused the caller (retry, or fix the setup). 2 is
 * usage: a bad command, a missing argument, an unreadable skill file, before any run starts. A
 * plain `!= 0` gate keeps working; one that read `1` as "any failure" now sees only regressions.
 */
export const FAIL_EXIT_CODE: Record<FailureClass, number> = { flow: 1, script: 3, environment: 4 };
export const USAGE_EXIT_CODE = 2;

export function exitCodeFor(verdict: Verdict): number {
  if (verdict.passed) return 0;
  return FAIL_EXIT_CODE[verdict.failure ?? "flow"];
}

/** A suite exits with the most demanding class among its failures: any regression blocks before
 * a stale script asks for re-discovery, which comes before an environment asks for a retry. */
export function suiteExitCode(verdicts: readonly Verdict[]): number {
  const codes = verdicts.filter((v) => !v.passed).map(exitCodeFor);
  if (codes.length === 0) return 0;
  if (codes.includes(FAIL_EXIT_CODE.flow)) return FAIL_EXIT_CODE.flow;
  if (codes.includes(FAIL_EXIT_CODE.script)) return FAIL_EXIT_CODE.script;
  return FAIL_EXIT_CODE.environment;
}
