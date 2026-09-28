---
issue: 245
pr: 262
status: in-progress
summary: Validate scoped secret origins before execution
next: Review and merge PR 262
---

Choose the explicit-scheme option from #245, consistent with the CLI's documented
requirement. The library and CLI share validateSecrets: HTTP(S) origin only, with
an optional explicit port and trailing slash. Malformed or host-only scopes are
configuration errors before run side effects, even when unused. Configuration
messages do not echo supplied origin contents or secret values. Hosts passing a
page URL must now pass its origin instead.

Valid off-site attempts retain runtime refusal. Host/subdomain matching and
explicit default ports are preserved, without mutating the caller's values or
adding implicit HTTPS. A non-HTTP(S) page cannot receive a scoped secret.

Typecheck, build, 1,233 workspace tests, 183 benchmark/script tests, and repository
checks passed. bench/local/secret-scope.mjs reproduces a valid form save, wrong-port
refusal, and malformed-scope preflight against real Chrome. All use zero model
calls; the fixture verifies whether the form was saved independently.
