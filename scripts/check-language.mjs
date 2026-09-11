#!/usr/bin/env node
/**
 * Everything a contributor reads is English. The repository already says so in its conventions, but
 * a convention only holds while someone remembers it, so this is a check rather than a rule: a
 * non-English character in tracked source, spec or documentation fails `verify`.
 *
 * The archive is exempt. Entries written before this check are kept verbatim rather than translated,
 * because a record rewritten after the fact is a worse record.
 *
 * A file that must carry non-English text to do its job, a fixture proving the engine tokenizes CJK
 * for example, opts out with the marker below on its own line. The opt-out is deliberate and
 * greppable rather than a path list, so it stays with the reason.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const CHECKED = /\.(ts|tsx|js|mjs|cjs|json|md|yml|yaml|html|svg)$/;
const EXEMPT = [/^spec\/journal\/archive\//, /^spec\/journal\/history\.md$/, /^docs\/design\.(md|html)$/, /^package-lock\.json$/];
const OPT_OUT = "language-check: non-English by design";
// CJK, Hangul, Hiragana, Katakana. Latin accents and emoji are fine.
const NON_ENGLISH = /[぀-ヿ㐀-䶿一-鿿가-힯]/;

const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0").filter((path) => path && CHECKED.test(path) && !EXEMPT.some((rule) => rule.test(path)));

const found = [];
let read = 0;
for (const path of files) {
  let text;
  // A tracked file can be absent mid-change: deleted on disk but not yet staged. Skip it rather
  // than crash, since the check is about what the repository will hold, not what git still lists.
  try { text = readFileSync(join(root, path), "utf8"); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
  read++;
  if (text.includes(OPT_OUT)) continue;
  text.split("\n").forEach((line, index) => {
    if (NON_ENGLISH.test(line)) found.push(`${path}:${index + 1}: ${line.trim().slice(0, 70)}`);
  });
}

if (found.length) {
  console.error(`Non-English text in ${new Set(found.map((f) => f.split(":")[0])).size} tracked file(s). Everything a contributor reads is English:\n`);
  for (const line of found.slice(0, 40)) console.error(`  ${line}`);
  if (found.length > 40) console.error(`  ... and ${found.length - 40} more`);
  process.exit(1);
}
console.log(`Language check passed: ${read} tracked files are English.`);
