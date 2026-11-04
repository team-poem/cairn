---
issue: 267
pr: 335
status: in-progress
summary: Submit the merge-commit automation repair for independent review
next: Obtain independent approval and current-head CI, merge into develop, and promote workflow queue settings to main
---

PR 335 aligns the bot with the existing merge-commit-only repository setting.
The implementation and validation are recorded in the earlier append-only entry.
The initial PR description omitted the required issue reference; the description
now links issue 267. This follow-up commit records the publication and gives CI
a fresh head without the obsolete failed description check.

The repair does not approve itself or bypass review. Trusted scripts are loaded
from develop; default-branch workflow definitions still need the normal release
flow for the new queue setting. Live activation remains pending those merges.
