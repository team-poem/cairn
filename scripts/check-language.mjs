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
const CHECKED = /\.(ts|tsx|js|mjs|cjs|json|md|yml|yaml|html|svg|sh)$/;
const EXEMPT = [/^spec\/journal\/archive\//, /^spec\/journal\/history\.md$/, /^docs\/design\.(md|html)$/, /^package-lock\.json$/];
// Scoped to a test or fixture path: the escape hatch exists for a fixture that must carry the text
// it proves the engine handles, not as a way for any file to exempt itself. It must also be the
// whole of a line, so a document can quote the marker without exempting itself.
const OPT_OUT = /^\s*(?:\/\/|#)\s*language-check: non-English by design\b.*$/m;
const MAY_OPT_OUT = /(^|\/)(test|tests|fixtures|__tests__)\//;
// CJK ideographs, kana and their halfwidth forms, CJK punctuation, Hangul syllables and both jamo
// blocks, and Cyrillic. Latin accents and emoji are fine.
const NON_ENGLISH = /[\u0400-\u04ff\u1100-\u11ff\u3000-\u303f\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff01-\uff60\uff65-\uff9f]/;

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
  if (OPT_OUT.test(text) && (MAY_OPT_OUT.test(path) || path.endsWith(".test.mjs") || path.endsWith(".test.ts"))) continue;
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
