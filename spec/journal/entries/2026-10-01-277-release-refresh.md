---
issue: 277
pr: null
status: in-progress
summary: Refresh a prepared unpublished release without rewriting its journal or PR notes
next: Review and run Prepare release from develop after all journal jobs complete
---

Same-version preparation is a refresh only when a matching release archive exists.
Late entries append to that archive; source identities and hashes make cleanup
retryable without duplicating content. Previously edited prose is not regenerated.
The existing 2.9.3 archive format is supported without rewriting its history.

Preparation checks npm, fetched tags and main before file changes and again before
pushing. Registry errors fail closed. Empty changes do not create commits. A
concurrent develop update aborts rather than rebasing or force-pushing generated
archives. Wait for journal jobs before the final preparation run; retried journal
jobs recognize PRs already in an archive.

An existing release PR keeps its title and body. A closed predecessor permits a
new draft, whose comparison uses the previous release rather than the prepared
package version. Nothing in preparation publishes or merges a release.
