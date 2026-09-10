# 2026-09-10 — concise performance comments

- PR #227: the user asked to remove the long interpretation paragraphs and
  provenance section from pingu-cairn's briefing, keeping the three tables.
- The comment requests a compact rendering. Package sizes, replay times and
  outcomes retain their values and failure status; the short briefing remains.
  Full Markdown artifacts keep the extended context and hashes by default.
- State change: comment detail is labeled "Detailed measurements" and ends
  after the three tables. The original report tests remain unchanged; preview
  checks verify the compact output has the same table rows and no context tail.
- Reflection: contribution comments should prioritize decisions and metric
  comparisons; reproducibility detail belongs in the linked artifacts. No
  harness files or existing journal entries were changed.
