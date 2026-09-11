# archive

One file per release. At release time `npm run journal:archive <version>` folds that cycle's entries
from `spec/journal/entries/` into a file here and leaves `entries/` empty for the next cycle.

Files up to and including `2.9.0` were written in Korean and were condensed into English summaries
when the language rule landed, so they carry each work item's decision rather than its full original
prose. The originals remain in git history. From `2.10.0` on, an archive is the entries verbatim.
