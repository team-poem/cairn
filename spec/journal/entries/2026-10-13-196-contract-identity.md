---
issue: 196
pr: null
status: in-progress
summary: Separate judgment contract identity from scenario creation provenance
next: Review the implementation and run the browser suite on a host that can launch Chrome
---

Freezes and verdicts carry a versioned judgment fingerprint, computed through the same browser-safe
canonical SHA-256 implementation on both public entry points. The material includes authoring intent,
assertions and declared judgment semantics, not execution settings or app-context provenance.
The suite cache key remains separate and unchanged. App-context loading/injection remains #282.

Legacy or opaque judgments without sufficient provenance compare as unknown. Hosts version custom
checks, semantic judges and external evidence interpretation with a judgment key. Replay recomputes
identity without rewriting historical freezes. Repair still judges the original checks and returns
a separate freeze; an unchanged judgment contract may retain its fingerprint after a path repair.

Typecheck, build, the full test command and the executable consumer example passed. Tests cover
canonicalization, legacy records, edited assertions, Node/browser export parity, suite merging,
reporter/trace metadata and repair. A real-browser regression test is included, but local execution
was blocked: the installed Chrome process aborted on launch and Playwright's fallback browser was
not installed. This is not recorded as a passing browser run.
