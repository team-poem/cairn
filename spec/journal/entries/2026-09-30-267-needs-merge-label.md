---
issue: 267
pr: 268
status: in-progress
summary: Rename the automatic squash merge request label to needs-merge
next: Review and merge PR 268, then include the workflow on main for scheduled retries
---

# Rename the automatic merge request label

The case-sensitive `needs-merge` label replaces `Merge` at the maintainer's request.
The workflow, merge gates, tests and contributor instructions use the new name.
The existing GitHub label is renamed in place, preserving any existing assignments.
Approval, CI, head SHA and develop-only requirements remain unchanged.
