#!/usr/bin/env node
/**
 * Draft a journal entry from a merged pull request.
 *
 * The journal exists because a decision is worth more than a diff, and it only works if an entry
 * actually gets written. A draft the maintainer edits is better than a rule nobody remembers, so
 * this writes the front matter from facts the pull request already carries and leaves the prose to
 * be improved in place.
 *
 * The pull request body is written by whoever opened it, including an outside contributor, so it is
 * data rather than trusted text: it is never interpolated into a shell, and it is dropped entirely
 * if it would break the repository's English rule, in favour of a link. Both would otherwise turn
 * develop's own CI red, which is a worse outcome than a thin entry.
 */
const NON_ENGLISH = /[぀-ヿ㐀-䶿一-鿿가-힯]/;
const CLOSES = /(?:closes|fixes|resolves)\s+#(\d+)/i;
const REFS = /\brefs?\s+#(\d+)/i;
const TRAILERS = [/^🤖 Generated with .*$/gim, /^https:\/\/claude\.ai\/code\/session_\S*$/gim, /^Assisted-by:.*$/gim, /^Co-Authored-By:.*$/gim];

/** A conventional-commit subject is a commit line, not a sentence; the journal wants the sentence. */
export function summaryOf(title) {
  const withoutType = title.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "").trim();
  const withoutIssue = withoutType.replace(/\s*\(#\d+\)\s*$/, "").trim();
  const text = withoutIssue || title.trim();
  return (text[0]?.toUpperCase() ?? "") + text.slice(1).replace(/[.]+$/, "");
}

export function issueOf(body, title) {
  const closes = CLOSES.exec(body ?? "");
  if (closes) return Number(closes[1]);
  const refs = REFS.exec(body ?? "");
  if (refs) return Number(refs[1]);
  const titled = /\(#(\d+)\)\s*$/.exec(title ?? "");
  return titled ? Number(titled[1]) : null;
}

/** Keep what a reader needs and drop what the pull request template repeats back. */
function cleanBody(body) {
  let text = body ?? "";
  for (const trailer of TRAILERS) text = text.replace(trailer, "");
  text = text
    .split("\n")
    .filter((line) => !/^\s*-\s*\[[ x]\]/i.test(line))
    .join("\n")
    .replace(/^#+\s*(Checklist|How it was verified|Related issue)\s*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

export function draftEntry({ number, title, body, mergedAt, author }) {
  const summary = summaryOf(title);
  const issue = issueOf(body, title);
  const prose = cleanBody(body);
  const usable = prose && !NON_ENGLISH.test(prose) && !NON_ENGLISH.test(summary);
  const front = [
    "---",
    `issue: ${issue ?? "null"}`,
    `pr: ${number}`,
    "status: landed",
    `summary: ${NON_ENGLISH.test(summary) ? `Pull request #${number}` : summary}`,
    "next: null",
    "---",
  ].join("\n");
  const head = `# ${NON_ENGLISH.test(summary) ? `Pull request #${number}` : summary}`;
  const note = `_Drafted from [#${number}](https://github.com/team-poem/cairn/pull/${number}) by ${author}. Edit this in place; do not delete and re-add it._`;
  const fallback = `This entry was drafted automatically and the pull request body could not be carried over. Read [#${number}](https://github.com/team-poem/cairn/pull/${number}) for what changed, and replace this paragraph with the decision worth keeping.`;
  return { date: (mergedAt ?? new Date().toISOString()).slice(0, 10), issue, body: `${front}\n\n${head}\n\n${note}\n\n${usable ? prose : fallback}\n` };
}

export const entryName = (date, issue, number) => `${date}-${issue ? `${issue}-` : ""}pr-${number}.md`;
