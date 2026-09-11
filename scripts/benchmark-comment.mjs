import { readFile, stat } from "node:fs/promises";
import { renderSizeOnlyComparison } from "../bench/ci-size-only.mjs";
import { compareReports, renderComparison } from "../bench/ci-report.mjs";

const marker = "<!-- cairn-pr-benchmarks -->";

const signed = value => `${value > 0 ? "+" : ""}${Number(value.toFixed(2))}`;
const percent = value => value === null ? "n/a" : value !== 0 && Math.abs(value) < 0.01
  ? `${value < 0 ? "-" : "+"}<0.01%` : `${signed(value)}%`;

// Only freshly validated comparisons reach this summary. Keep observed timing
// changes separate from the outcome: an invalid tier has no speed claim.
export function renderBriefing(comparison) {
  const { packageBytes, browserGzipBytes } = comparison.sizes;
  const sides = comparison.tiers.flatMap(row => [row.base, row.head]);
  const sum = key => sides.some(side => side[key] === null) ? "unknown" : sides.reduce((total, side) => total + side[key], 0);
  const timing = comparison.tiers.map(row => `${row.tier}: ${row.status === "invalid" ? "invalid (failed or LLM-tainted)" : percent(row.percent)}`).join("; ");
  return [
    "## 🐧 Performance briefing", "",
    `- Package tarball: ${signed(packageBytes.delta)} B (${percent(packageBytes.percent)}). Browser gzip: ${signed(browserGzipBytes.delta)} B (${percent(browserGzipBytes.percent)}).`,
    `- Observed replay medians: ${timing}.`,
    `- Execution across both revisions: ${sum("runs") - sum("failures")}/${sum("runs")} passed; engine LLM calls: ${sum("llmCalls")}; observed LLM calls: ${sum("observedLlmCalls")}.`,
    "- Timing includes server/browser startup and awaited cleanup; small samples and CI noise do not prove an improvement or regression. Residual order bias may remain.", "",
  ].join("\n");
}

// No artifact-supplied Markdown, paths, PR numbers or repository names are used.
// Measurement data is produced by PR code. Only same-repository PRs receive
// app-signed reports; fork results remain in Actions. This module runs from the
// default branch with the narrowly scoped comment token.
export async function postBenchmarkComment({ github, context, core, appSlug }) {
  if (typeof appSlug !== "string" || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(appSlug)) throw new Error("Missing or invalid GitHub App slug");
  const run = context.payload.workflow_run;
  if (run.event !== "pull_request" || run.path?.split("@")[0] !== ".github/workflows/benchmark.yml") throw new Error("Unexpected benchmark workflow");
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  if (run.head_repository?.full_name !== repository) { core.info("Fork measurement; leaving the summary in Actions"); return; }
  const { data: associated } = await github.rest.repos.listPullRequestsAssociatedWithCommit({ ...context.repo, commit_sha: run.head_sha, per_page: 100 });
  const candidates = associated.filter(pr => pr.state === "open" && pr.head.sha === run.head_sha
    && pr.base.repo.full_name === `${context.repo.owner}/${context.repo.repo}`
    && pr.head.repo?.full_name === run.head_repository?.full_name);
  if (candidates.length !== 1) { core.info("No unique current PR for this run; leaving the summary in Actions"); return; }
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: candidates[0].number });
  if (pr.state !== "open" || pr.head.sha !== run.head_sha || pr.head.repo?.full_name !== repository || pr.base.repo?.full_name !== repository) { core.info("Stale or ineligible benchmark run"); return; }
  const botLogin = `${appSlug}[bot]`;
  const { data: bot } = await github.rest.users.getByUsername({ username: botLogin });
  if (bot.type !== "Bot" || bot.login !== botLogin || !Number.isSafeInteger(bot.id) || bot.id <= 0) throw new Error("Could not verify the GitHub App bot identity");
  let text = `## 🐧 Performance briefing\n\nHead: ${pr.head.sha}\n\nMeasurement did not complete successfully. Inspect the job log and available artifacts; no performance improvement is claimed.\n`;
  try {
    const path = "benchmark-data/paired.json";
    if ((await stat(path)).size > 1000000) throw new Error("Oversized measurement data");
    const pair = JSON.parse(await readFile(path, "utf8"));
    if (pair.base?.commit !== pr.base.sha || pair.head?.commit !== pr.head.sha) { core.info("Stale base/head comparison"); return; }
    if (pair.kind === "size-only") {
      if (run.conclusion !== "success") throw new Error("Workflow failed; size-only comparison withheld");
      text = `## 🐧 Performance briefing\n\n${renderSizeOnlyComparison(pair, { includeContext: false })}`;
    } else {
      if (pair.warmupFailed !== false) throw new Error("Warmup did not complete successfully");
      const comparison = compareReports(pair.base, pair.head);
      if (run.conclusion !== "success" && comparison.tiers.every(row => row.status !== "invalid")) throw new Error("Workflow failed despite successful samples; timing comparison withheld");
      text = `${renderBriefing(comparison)}\n<details>\n<summary>Detailed measurements</summary>\n\n${renderComparison(comparison, { includeContext: false, includeP95: false })}\n</details>\n`;
      if (run.conclusion !== "success") text += "\n**The measurement check failed. Inspect the raw attempts before drawing conclusions.**\n";
    }
  } catch (error) {
    core.warning(`Comparison unavailable: ${error.message}`);
  }
  const runLink = `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${run.id}`;
  const body = `${marker}\n<!-- benchmark-run:${run.id}:${run.run_attempt} -->\n${text}\n[Raw measurements and job log](${runLink})\n`;
  const comments = await github.paginate(github.rest.issues.listComments, { ...context.repo, issue_number: pr.number, per_page: 100 });
  const existing = comments.find(comment => comment.user?.id === bot.id && comment.body?.startsWith(marker));
  const previous = existing?.body?.match(/<!-- benchmark-run:(\d+):(\d+) -->/);
  if (previous && (Number(previous[1]) > run.id || (Number(previous[1]) === run.id && Number(previous[2]) > run.run_attempt))) return;
  const { data: current } = await github.rest.pulls.get({ ...context.repo, pull_number: pr.number });
  if (current.state !== "open" || current.head.sha !== pr.head.sha || current.base.sha !== pr.base.sha
    || current.head.repo?.full_name !== repository || current.base.repo?.full_name !== repository) return;
  if (existing) await github.rest.issues.updateComment({ ...context.repo, comment_id: existing.id, body });
  else await github.rest.issues.createComment({ ...context.repo, issue_number: pr.number, body });
}
