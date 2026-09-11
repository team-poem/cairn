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
import { readdir, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
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
  return { name, meta, body: text.slice(match[0].length).trim() };
}

async function readEntries() {
  let names;
  try { names = (await readdir(dirs.entries)).filter((n) => n.endsWith(".md")).sort(); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const out = [];
  for (const name of names) out.push(parseEntry(name, await readFile(join(dirs.entries, name), "utf8")));
  return out;
}

const label = (entry) => [entry.meta.issue && `#${entry.meta.issue}`, entry.meta.pr && `PR #${entry.meta.pr}`].filter(Boolean).join(" · ");

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
async function archive(version, entries) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error("Usage: journal.mjs archive <version>");
  if (!entries.length) throw new Error("Nothing to archive: entries/ is empty");
  const path = join(dirs.archive, `${version}.md`);
  const date = new Date().toISOString().slice(0, 10);
  const body = entries.map((entry) => {
    // An entry's own H1 repeats the summary, which becomes the section heading here.
    const head = `## ${entry.meta.summary}`;
    const meta = [label(entry), entry.meta.status !== "landed" ? entry.meta.status : null].filter(Boolean).join(" · ");
    return [head, meta ? `*${meta}*` : null, "", entry.body.replace(/^# .*\n+/, "")].filter((part) => part !== null).join("\n");
  }).join("\n\n---\n\n");
  await mkdir(dirs.archive, { recursive: true });
  await writeFile(path, `# ${version}\n\nArchived ${date}. ${entries.length} entries from the ${version} cycle.\n\n${body}\n`, { flag: "wx" });
  for (const entry of entries) await rm(join(dirs.entries, entry.name));
  return `${path}\n${entries.length} entries archived; entries/ is empty for the next cycle.`;
}

const [command, argument] = process.argv.slice(2);
try {
  const entries = await readEntries();
  if (command === "status") console.log(status(entries));
  else if (command === "check") console.log(`Journal OK: ${entries.length} entr${entries.length === 1 ? "y" : "ies"} in the current cycle.`);
  else if (command === "archive") console.log(await archive(argument, entries));
  else { console.error("Usage: journal.mjs <status|check|archive <version>>"); process.exit(2); }
} catch (error) {
  console.error(`journal: ${error.message}`);
  process.exit(1);
}
