---
issue: 231
pr: null
status: in-progress
summary: Share Chrome initialization and stop splitting global perception failures
next: Review the scoped change; per-document reference guards remain deferred.
---

# Driver initialization and perception cleanup

The scoped change addresses issue 231 items 1, 2 and 4. Concurrent first calls
share the full connection and capability negotiation. Closing during initialization
releases the pending transport. A failed startup remains retryable, while losing an
established browser session remains terminal.

Perception splits only recognized mixed-frame and stale-element failures. Other
non-transport errors retain candidates without unmeasured facts or exact refs and
stop the affected batch. This preserves the existing prohibition on retrying a
failed evaluation with a different wait mode. Item 3's whole-capture fallback for
unguarded frame or shadow rows is unchanged; partial references require a separate
document and ordinal safety design.

Actual MCP 1.8 validation caught a missing `Error: ` prefix in the first error
classifier. MCP's normal response renderer adds that prefix even though the
underlying thrown message lacks it. An appended regression now exercises the real
driver error-envelope path for mixed-frame and stale-element messages.

Two benchmark publisher tests separate commit-associated candidates from PR detail
responses. Both pass normally and fail when only the candidate repository equality
is removed. The publisher implementation and existing test lines are unchanged.

Validation: 1,172 engine tests, 183 benchmark contract tests and 21 browser tests
passed, together with typecheck, build and independent review. A local fixture using
real MCP 1.8 and isolated Chrome confirmed one process for cold `observe()`, an exact
reference click, three measurements retaining five iframe-page candidates and main
document facts without refs, and successful retry after a process exits during
startup. The successful and failed-startup sessions left no MCP wrapper processes.

The work remains local on `codex/231-driver-cleanups`; no pull request or issue
closure is included.
