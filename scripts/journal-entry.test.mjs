import { strict as assert } from "node:assert";
import { test } from "node:test";
import { draftEntry, entryName, issueOf, summaryOf } from "./journal-entry.mjs";

const pr = (patch = {}) => ({ number: 240, title: "fix(core): stop the retry from switching pools", body: "## What\n\nScope the verbose retry.\n\n## Related issue\n\nCloses #229\n\n## Checklist\n\n- [x] tests pass\n", mergedAt: "2026-09-20T10:00:00Z", author: "solp721", ...patch });

test("journalEntrySummaryDropsTheCommitPrefix", () => {
  assert.equal(summaryOf("fix(core): send the element listing on every turn"), "Send the element listing on every turn");
  assert.equal(summaryOf("bench: measure self-heal on a fixture change (#230)"), "Measure self-heal on a fixture change");
  assert.equal(summaryOf("feat!: break the thing."), "Break the thing");
  // A title that is already a sentence survives unchanged.
  assert.equal(summaryOf("Release cairn-engine 2.9.0"), "Release cairn-engine 2.9.0");
});

test("journalEntryFindsTheIssueInClosesThenRefsThenTitle", () => {
  assert.equal(issueOf("Closes #225", "x"), 225);
  assert.equal(issueOf("Refs #220", "x"), 220);
  // Closes wins over Refs when a body carries both.
  assert.equal(issueOf("Refs #220\nCloses #225", "x"), 225);
  assert.equal(issueOf("no issue here", "feat: thing (#12)"), 12);
  assert.equal(issueOf("", "feat: thing"), null);
});

test("journalEntryCarriesTheBodyAndDropsTemplateNoise", () => {
  const entry = draftEntry(pr());
  assert.match(entry.body, /^---\nissue: 229\npr: 240\nstatus: landed\nsummary: Stop the retry from switching pools\nnext: null\n---/);
  assert.match(entry.body, /Scope the verbose retry\./);
  // Checklist rows and the headings that only repeat the template are not a record of anything.
  assert.doesNotMatch(entry.body, /\[x\]/);
  assert.doesNotMatch(entry.body, /## Checklist/);
  assert.equal(entry.date, "2026-09-20");
  assert.equal(entryName(entry.date, entry.issue, 240), "2026-09-20-229-pr-240.md");
});

test("journalEntryDropsAssistantTrailers", () => {
  const entry = draftEntry(pr({ body: "Real content.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nhttps://claude.ai/code/session_01ABC\n" }));
  assert.match(entry.body, /Real content\./);
  assert.doesNotMatch(entry.body, /Generated with/);
  assert.doesNotMatch(entry.body, /session_01ABC/);
});

test("journalEntryRefusesToCarryNonEnglishIntoDevelop", () => {
  // A contributor may write in any language; the repository may not. Carrying it would turn
  // develop's own language check red, which is worse than a thin entry that links the source.
  const entry = draftEntry(pr({ body: "## What\n\n한국어 본문입니다.\n" }));
  assert.doesNotMatch(entry.body, /[가-힣]/);
  assert.match(entry.body, /could not be carried over/);
  assert.match(entry.body, /pull\/240/);
});

test("journalEntryFallsBackWhenTheTitleItselfIsNonEnglish", () => {
  const entry = draftEntry(pr({ title: "fix: 요소 목록 문제", body: "English body." }));
  assert.doesNotMatch(entry.body, /[가-힣]/);
  assert.match(entry.body, /summary: Pull request #240/);
});

test("journalEntryHandlesAnEmptyBody", () => {
  const entry = draftEntry(pr({ body: "" }));
  assert.match(entry.body, /could not be carried over/);
  assert.equal(entry.issue, null);
  assert.equal(entryName(entry.date, entry.issue, 240), "2026-09-20-pr-240.md");
});
