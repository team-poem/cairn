// language-check: non-English by design — one fixture proves a non-English body is refused.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** A scratch copy of the scripts plus an empty journal, so a test can fold without touching the repo. */
async function sandbox(t, entries = {}) {
  const dir = await mkdtemp(join(tmpdir(), "cairn-journal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "scripts"), { recursive: true });
  await mkdir(join(dir, "spec/journal/entries"), { recursive: true });
  await mkdir(join(dir, "packages/harness"), { recursive: true });
  for (const name of ["journal.mjs", "release-prepare.mjs"]) await cp(join(root, "scripts", name), join(dir, "scripts", name));
  for (const [name, body] of Object.entries(entries)) await writeFile(join(dir, "spec/journal/entries", name), body);
  return dir;
}
const run = (dir, args) => execFileSync(process.execPath, args, { cwd: dir, encoding: "utf8" });
const fails = (dir, args) => {
  try { run(dir, args); return null; }
  catch (error) { return `${error.stdout ?? ""}${error.stderr ?? ""}`.trim(); }
};
const entry = (summary, extra = "") => `---\nissue: 42\npr: 99\nstatus: landed\nsummary: ${summary}\nnext: null\n---\n\n# ${summary}\n\n${extra || "Body."}\n`;

test("journalCheckRefusesAnEntryItCannotRead", async (t) => {
  for (const [name, body, expected] of [
    ["2026-01-01-a.md", "no front matter at all\n", /missing front matter/],
    ["2026-01-01-b.md", "---\nstatus landed\n---\nx\n", /cannot read front-matter line/],
    ["2026-01-01-c.md", "---\nstatus: shipped\nsummary: x\n---\ny\n", /status must be one of/],
    ["2026-01-01-d.md", "---\nstatus: landed\n---\ny\n", /front matter needs summary/],
    ["no-date.md", entry("A summary"), /filename must start YYYY-MM-DD-/],
  ]) {
    const dir = await sandbox(t, { [name]: body });
    assert.match(fails(dir, ["scripts/journal.mjs", "check"]) ?? "", expected, name);
  }
});

test("journalCheckRefusesABlankSummary", async (t) => {
  // A blank summary passes a null check but renders as an empty heading in the archive.
  const dir = await sandbox(t, { "2026-01-01-a.md": "---\nstatus: landed\nsummary:\n---\nBody.\n" });
  assert.match(fails(dir, ["scripts/journal.mjs", "check"]) ?? "", /front matter needs summary/);
});

test("journalStatusGroupsByStatusAndShowsTheNextLine", async (t) => {
  const dir = await sandbox(t, {
    "2026-01-01-a.md": entry("Landed thing"),
    "2026-01-02-b.md": "---\nissue: 7\nstatus: blocked\nsummary: Blocked thing\nnext: waiting on #8\n---\n\nBody.\n",
  });
  const out = run(dir, ["scripts/journal.mjs", "status"]);
  assert.match(out, /LANDED \(1\)/);
  assert.match(out, /BLOCKED \(1\)/);
  assert.match(out, /next: waiting on #8/);
  assert.match(out, /\[#42 · PR #99\]/);
});

test("journalArchiveFoldsTheCycleAndLeavesTheDirectoryUsable", async (t) => {
  const dir = await sandbox(t, { "2026-01-01-a.md": entry("First thing"), "2026-01-02-b.md": entry("Second thing") });
  const out = run(dir, ["scripts/journal.mjs", "archive", "2.10.0"]);
  assert.match(out, /2 entries archived/);
  const archived = await readFile(join(dir, "spec/journal/archive/2.10.0.md"), "utf8");
  assert.match(archived, /^# 2\.10\.0/);
  assert.match(archived, /## First thing\n\*#42 · PR #99\*\n\nBody\./);
  // The entry's own H1 repeats the summary, so it must not survive as a second heading.
  assert.doesNotMatch(archived, /\n# First thing/);
  assert.deepEqual((await readdir(join(dir, "spec/journal/entries"))).filter((n) => n.endsWith(".md")), []);
  // The next cycle must be able to write here, so the fold cannot leave the path gone.
  assert.equal(run(dir, ["scripts/journal.mjs", "check"]).trim(), "Journal OK: 0 entries in the current cycle.");
});

test("journalArchiveRefusesToOverwriteAndKeepsTheEntriesWhenItCannotWrite", async (t) => {
  const dir = await sandbox(t, { "2026-01-01-a.md": entry("First thing") });
  run(dir, ["scripts/journal.mjs", "archive", "2.10.0"]);
  await writeFile(join(dir, "spec/journal/entries/2026-01-02-b.md"), entry("Second thing"));
  assert.match(fails(dir, ["scripts/journal.mjs", "archive", "2.10.0"]) ?? "", /EEXIST|already/i);
  // The refusal must not eat the cycle it declined to fold.
  assert.deepEqual((await readdir(join(dir, "spec/journal/entries"))).filter((n) => n.endsWith(".md")), ["2026-01-02-b.md"]);
});

test("journalArchiveRejectsAVersionThatIsNotOne", async (t) => {
  const dir = await sandbox(t, { "2026-01-01-a.md": entry("Thing") });
  for (const bad of ["2.9", "latest", "2.9.0; touch /tmp/pwned", "../../etc/x"]) {
    assert.match(fails(dir, ["scripts/journal.mjs", "archive", bad]) ?? "", /Usage/, bad);
  }
});

test("journalArchiveRefusesAnEmptyCycle", async (t) => {
  const dir = await sandbox(t);
  assert.match(fails(dir, ["scripts/journal.mjs", "archive", "2.10.0"]) ?? "", /entries\/ is empty/);
});

test("journalArchiveMovesAnEntrysOwnHeadingsUnderItsTitle", async (t) => {
  const body = "# Top\n\n## A section\n\nText.\n\n### Deeper\n\n```sh\n# not a heading\n```\n\n#hashtag\n";
  const dir = await sandbox(t, { "2026-01-01-a.md": `---\nissue: 42\npr: 99\nstatus: landed\nsummary: First thing\nnext: null\n---\n\n${body}` });
  run(dir, ["scripts/journal.mjs", "archive", "2.10.0"]);
  const archived = await readFile(join(dir, "spec/journal/archive/2.10.0.md"), "utf8");
  // The entry title owns ##, so its sections sit below it rather than beside it.
  assert.match(archived, /\n## First thing\n/);
  assert.match(archived, /\n### A section\n/);
  assert.match(archived, /\n#### Deeper\n/);
  assert.doesNotMatch(archived, /\n## A section\n/);
  // A leading # inside a fence is a shell comment, and a word after # is not a heading at all.
  assert.match(archived, /\n# not a heading\n/);
  assert.match(archived, /\n#hashtag\n/);
});
