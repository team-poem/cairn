import type { StepErrorKind } from "./types.js";

const KINDS: ReadonlySet<string> = new Set(["resolution", "post-condition", "timeout", "transport", "handler"]);

/** An Error that says what kind of failure it is, as a plain `kind` property — structural, so a
 * Driver written outside this package can throw one without importing anything (#212). */
export function stepError(kind: StepErrorKind, message: string): Error & { kind: StepErrorKind } {
  return Object.assign(new Error(message), { kind });
}

/** The typed cause of a thrown value, if the thrower said; `undefined` for an untyped throw. */
export function errorKindOf(err: unknown): StepErrorKind | undefined {
  const kind = (err as { kind?: unknown } | null)?.kind;
  return typeof kind === "string" && KINDS.has(kind) ? (kind as StepErrorKind) : undefined;
}
