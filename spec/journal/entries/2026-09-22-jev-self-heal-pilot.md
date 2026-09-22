---
issue: null
pr: null
status: in-progress
summary: Prepare an opt-in hosted Jev locator-choice pilot with fail-closed verification
next: Approve hosted evaluation credentials and budget, and establish cumulative request evidence before adoption
---

The pilot adds a narrow typed target selector behind the existing Driver decorator, preserving
ordinary replay and the legacy healer. It reuses the observation reference table and requires
original intent, post-condition and goal evidence. None, low confidence, missing evidence and
provider failures stop the repair without an implicit fallback. No production threshold is chosen.

A selected or dispatched target is tentative until the existing step verifier succeeds; the
original goals also gate the returned healed scenario. Trace 1.7 adds decision evidence without
changing proof grades. No LlmClient string/JSON bridge or generic decision framework is introduced.

Official TypeSafe and Cloudflare documentation were checked on 2026-09-22. The direct adapter
pins Jev 1.13.0; Cloudflare is a verified later candidate, not implemented. There was no TypeSafe
credential or approved evaluation budget, so all provider responses used in validation were mocks.

The actual #230 v3 fixture exposed a pre-existing Driver evidence issue: the latest-page network
log loses the order request, and the preserved sliding window still breaks per-step watermarks.
The pilot refused to confirm or re-freeze. With a bench-only append-only request-ID diagnostic
adapter, unchanged order and destination checks passed, followed by zero-call replay in a fresh
browser. That adapter is not a production fix. Adoption requires a conforming cumulative evidence
source and a separately approved hosted comparison. See docs/research/jev-self-heal-pilot.md.
