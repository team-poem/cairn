import { readFile, stat } from "node:fs/promises";
import { compareReports, renderComparison } from "../bench/ci-report.mjs";

const marker = "<!-- cairn-pr-benchmarks -->";

// No artifact-supplied Markdown, paths, PR numbers or repository names are used.
// Fork code runs in the read-only measurement job; this module runs from the
// default branch with the narrowly scoped comment token.
export async function postBenchmarkComment({ github, context, core }) {
  const run = context.payload.workflow_run;
  if (run.event !== "pull_request" || run.path?.split("@")[0] !== ".github/workflows/benchmark.yml") throw new Error("Unexpected benchmark workflow");
  const { data: associated } = await github.rest.repos.listPullRequestsAssociatedWithCommit({ ...context.repo, commit_sha: run.head_sha, per_page: 100 });
  const candidates = associated.filter(pr => pr.state === "open" && pr.head.sha === run.head_sha
    && pr.base.repo.full_name === `${context.repo.owner}/${context.repo.repo}`
    && pr.head.repo?.full_name === run.head_repository?.full_name);
  if (candidates.length !== 1) { core.info("No unique current PR for this run; leaving the summary in Actions"); return; }
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: candidates[0].number });
  if (pr.state !== "open" || pr.head.sha !== run.head_sha) { core.info("Stale benchmark run"); return; }
  let text = `# Cairn PR benchmarks\n\nHead: ${pr.head.sha}\n\nMeasurement did not complete successfully. Inspect the job log and available artifacts; no performance improvement is claimed.\n`;
  try {
    const path = "benchmark-data/paired.json";
    if ((await stat(path)).size > 1000000) throw new Error("Oversized measurement data");
    const pair = JSON.parse(await readFile(path, "utf8"));
    if (pair.base?.commit !== pr.base.sha || pair.head?.commit !== pr.head.sha) { core.info("Stale base/head comparison"); return; }
    if (pair.warmupFailed !== false) throw new Error("Warmup did not complete successfully");
    const comparison = compareReports(pair.base, pair.head);
    if (run.conclusion !== "success" && comparison.tiers.every(row => row.status !== "invalid")) throw new Error("Workflow failed despite successful samples; timing comparison withheld");
    text = renderComparison(comparison);
    if (run.conclusion !== "success") text += "\n**The measurement check failed. Inspect the raw attempts before drawing conclusions.**\n";
  } catch (error) {
    core.warning(`Comparison unavailable: ${error.message}`);
  }
  const runLink = `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${run.id}`;
  const body = `${marker}\n<!-- benchmark-run:${run.id}:${run.run_attempt} -->\n${text}\n[Raw measurements and job log](${runLink})\n`;
  const comments = await github.paginate(github.rest.issues.listComments, { ...context.repo, issue_number: pr.number, per_page: 100 });
  const existing = comments.find(comment => comment.user?.login === "github-actions[bot]" && comment.body?.startsWith(marker));
  const previous = existing?.body?.match(/<!-- benchmark-run:(\d+):(\d+) -->/);
  if (previous && (Number(previous[1]) > run.id || (Number(previous[1]) === run.id && Number(previous[2]) > run.run_attempt))) return;
  const { data: current } = await github.rest.pulls.get({ ...context.repo, pull_number: pr.number });
  if (current.state !== "open" || current.head.sha !== pr.head.sha || current.base.sha !== pr.base.sha) return;
  if (existing) await github.rest.issues.updateComment({ ...context.repo, comment_id: existing.id, body });
  else await github.rest.issues.createComment({ ...context.repo, issue_number: pr.number, body });
}
