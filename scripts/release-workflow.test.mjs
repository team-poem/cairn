import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const workflow = await readFile(new URL("../.github/workflows/release-prepare.yml", import.meta.url), "utf8");
const journal = await readFile(new URL("../.github/workflows/journal-entry.yml", import.meta.url), "utf8");

test("release workflow wires the original previous version and preserves PR notes", () => {
  assert.match(workflow, /PREVIOUS: \$\{\{ steps\.prepare\.outputs\.previous \}\}/);
  assert.match(workflow, /node scripts\/release-push\.mjs "\$VERSION"/);
  assert.match(workflow, /ensureReleasePullRequest/);
  assert.doesNotMatch(workflow, /pulls\.update|git push.*--force/);
  assert.match(workflow, /git add --intent-to-add/);
  assert(workflow.indexOf("Require journal generation") < workflow.indexOf("npm run release:prepare"));
  assert.match(journal, /archiveRecordsPullRequest/);
  assert.doesNotMatch(journal, /git push.*--force/);
});

test("the workflow refuses active journal jobs before preparation", async () => {
  const source = workflow.split("- name: Require journal generation to finish first")[1]
    .split("script: |\n")[1].split("      - name:")[0]
    .split("\n").map(line => line.replace(/^ {12}/, "")).join("\n");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const check = new AsyncFunction("github", "context", source);
  for (const busy of ["queued", "in_progress", "waiting", "pending", "requested", null]) {
    const github = { rest: { actions: { listWorkflowRuns: async args => {
      assert.equal(args.workflow_id, "journal-entry.yml");
      assert.equal(args.branch, "develop");
      return { data: { total_count: args.status === busy ? 1 : 0 } };
    } } } };
    if (busy) await assert.rejects(check(github, { repo: {} }), /Journal entry is still running/);
    else await check(github, { repo: {} });
  }
});
