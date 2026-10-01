#!/usr/bin/env node
/**
 * The journal harness.
 *
 * `entries/` is append-only: one file per work item, never edited after it lands, so two branches
 * can never conflict in it. Everything that used to be hand-maintained in `state.md` and went stale
 * is derived from those entries instead, which is why `state.md` no longer needs a rule about which
 * branch may edit it. At release time the cycle's entries fold into one archive file and `entries/`
 * starts empty again, so it holds a cycle rather than a history.
 */
import { readdir, readFile, writeFile, rm, mkdir, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dirs = { entries: join(root, "spec/journal/entries"), archive: join(root, "spec/journal/archive") };
const STATUSES = ["landed", "in-progress", "blocked", "abandoned"];
const REQUIRED = ["status", "summary"];

/** Front matter is the contract that makes an entry machine-readable; the body stays prose. */
function parseEntry(name, text) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) throw new Error(`${name}: missing front matter`);
  const meta = {};
  for (const line of match[1].split("\n")) {
    if (!line.trim()) continue;
    const at = line.indexOf(":");
    if (at < 0) throw new Error(`${name}: cannot read front-matter line ${JSON.stringify(line)}`);
    const key = line.slice(0, at).trim();
    const raw = line.slice(at + 1).trim();
    meta[key] = raw === "" || raw === "null" ? null : /^\d+$/.test(raw) ? Number(raw) : raw.replace(/^["']|["']$/g, "");
  }
  for (const key of REQUIRED) if (meta[key] === undefined || meta[key] === null) throw new Error(`${name}: front matter needs ${key}`);
  if (!STATUSES.includes(meta.status)) throw new Error(`${name}: status must be one of ${STATUSES.join(", ")}`);
  if (!/^\d{4}-\d{2}-\d{2}-/.test(name)) throw new Error(`${name}: filename must start YYYY-MM-DD-`);
  return { name, meta, text, body: text.slice(match[0].length).trim() };
}

export async function readEntries(directory = dirs.entries) {
  let names;
  // A missing directory is an empty cycle. Read-only checks must not create release files.
  try { names = (await readdir(directory)).filter((n) => n.endsWith(".md")).sort(); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const out = [];
  for (const name of names) out.push(parseEntry(name, await readFile(join(directory, name), "utf8")));
  return out;
}

const label = (entry) => [entry.meta.issue && `#${entry.meta.issue}`, entry.meta.pr && `PR #${entry.meta.pr}`].filter(Boolean).join(" · ");

/**
 * An entry is a document with its own headings; in an archive it is a section under the entry title,
 * so every heading below it moves down one level. Fenced blocks are left alone, where a leading # is
 * a comment rather than a heading.
 */
function demote(body) {
  let fenced = false;
  return body.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    return !fenced && /^#{1,5} /.test(line) ? `#${line}` : line;
  }).join("\n");
}

/** What is in flight, derived rather than remembered. Printed, never committed, so it cannot rot. */
function status(entries) {
  if (!entries.length) return "The current cycle has no entries yet.";
  const lines = [];
  for (const status of STATUSES) {
    const group = entries.filter((entry) => entry.meta.status === status);
    if (!group.length) continue;
    lines.push(`\n${status.toUpperCase()} (${group.length})`);
    for (const entry of group) {
      lines.push(`  ${entry.meta.summary}${label(entry) ? `  [${label(entry)}]` : ""}`);
      if (entry.meta.next) lines.push(`    next: ${entry.meta.next}`);
      lines.push(`    ${entry.name}`);
    }
  }
  return lines.join("\n").trim();
}

/** One file per release, so `entries/` carries a cycle and the repository carries the history. */
export async function archive(version, entries, { directories = dirs, refresh = false } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error("Usage: journal.mjs archive <version>");
  const path = join(directories.archive, `${version}.md`);
  let existing = null;
  try { existing = await readFile(path, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing !== null && !refresh) throw new Error(`Archive already exists: ${path}`);
  if (refresh && (existing === null || !existing.startsWith(`# ${version}\n`))) {
    throw new Error(`No matching prepared archive for ${version}`);
  }
  if (!entries.length) {
    if (refresh) return "No new journal entries.";
    throw new Error("Nothing to archive: entries/ is empty");
  }
  const date = new Date().toISOString().slice(0, 10);
  const additions = entries.map((entry) => {
    const identity = `<!-- journal-entry:${encodeURIComponent(entry.name)} sha256:`;
    const marker = `${identity}${createHash("sha256").update(entry.text).digest("hex")} -->`;
    // A crash after writing the archive but before removing entries is retryable. If the
    // source changed since that write, keep it for a human rather than silently discard it.
    if (existing?.includes(identity)) {
      if (!existing.includes(marker)) throw new Error(`Archived entry changed: ${entry.name}`);
      return null;
    }
    // An entry's own H1 repeats the summary, which becomes the section heading here.
    const head = `## ${entry.meta.summary}`;
    const meta = [label(entry), entry.meta.status !== "landed" ? entry.meta.status : null].filter(Boolean).join(" · ");
    return [marker, head, meta ? `*${meta}*` : null, "", demote(entry.body.replace(/^# .*\n+/, ""))].filter((part) => part !== null).join("\n");
  }).filter(Boolean);
  const body = additions.join("\n\n---\n\n");
  await mkdir(directories.archive, { recursive: true });
  if (existing === null) {
    await writeFile(path, `# ${version}\n\nArchived ${date}. ${entries.length} entries from the ${version} cycle.\n\n${body}\n`, { flag: "wx" });
  } else if (additions.length) {
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, `${existing}\n---\n\nAdded ${additions.length} entries on ${date} before release.\n\n${body}\n`, { flag: "wx" });
      if (await readFile(path, "utf8") !== existing) throw new Error("Archive changed during preparation; retry");
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  // Only the exact snapshot successfully archived may be removed; new files stay untouched.
  for (const entry of entries) {
    const source = join(directories.entries, entry.name);
    if (await readFile(source, "utf8") !== entry.text) throw new Error(`Entry changed during preparation: ${entry.name}`);
    await rm(source);
  }
  return `${path}\n${additions.length} entries archived; processed entries removed from the active cycle.`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, argument] = process.argv.slice(2);
  try {
    const entries = await readEntries();
    if (command === "status") console.log(status(entries));
    else if (command === "check") console.log(`Journal OK: ${entries.length} entr${entries.length === 1 ? "y" : "ies"} in the current cycle.`);
    else if (command === "archive") console.log(await archive(argument, entries));
    else { console.error("Usage: journal.mjs <status|check|archive <version>>"); process.exitCode = 2; }
  } catch (error) {
    console.error(`journal: ${error.message}`);
    process.exitCode = 1;
  }
}
