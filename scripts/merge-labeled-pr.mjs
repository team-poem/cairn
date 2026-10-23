import { mergeLabelBlocker } from "./merge-label-policy.mjs";
import { postMergeDecisionComment } from "./merge-decision-comment.mjs";

const query = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number state isDraft baseRefName headRefOid title reviewDecision mergeStateStatus
      labels(first: 100) { nodes { name } pageInfo { hasNextPage } }
    }
  }
}`;

function blocker(pr) {
  const labelReason = mergeLabelBlocker(pr);
  if (labelReason) return labelReason;
  if (pr.state !== "OPEN") return "pull request is not open.";
  if (pr.isDraft) return "pull request is a draft.";
  if (pr.baseRefName !== "develop") return "only pull requests targeting develop can be merged.";
  if (pr.reviewDecision !== "APPROVED") return `waiting for approval (review decision: ${pr.reviewDecision ?? "none"}).`;
  return null;
}

// The App can bypass rulesets, so approval and CI must be checked explicitly.
// Use GitHub's squash API: GitHub credits the PR author and records the App as merger.
export async function mergeLabeledPullRequests({ github, ciGithub = github, context, core }) {
  const { owner, repo } = context.repo;
  const messages = [];
  const notices = new Map();
  const report = (number, message) => {
    const line = `PR #${number}: ${message}`;
    core.info(line);
    messages.push(line);
  };
  const notice = (pr, message, createIfMissing = true) => {
    if (pr?.baseRefName === "develop" && ["OPEN", "MERGED", "CLOSED"].includes(pr.state)) {
      notices.set(pr.number, { pr, message, createIfMissing });
    }
  };
  const read = async number => (await github.graphql(query, { owner, repo, number })).repository.pullRequest;
  const snapshot = pr => JSON.stringify([
    pr.headRefOid, pr.isDraft, pr.reviewDecision, pr.mergeStateStatus,
    pr.labels.pageInfo?.hasNextPage, pr.labels.nodes.map(label => label.name).sort(),
  ]);
  const flushNotices = async () => {
    // Comments are informational. Posting failures must not change merge decisions.
    for (const update of notices.values()) {
      try {
        const current = await read(update.pr.number);
        if (!current || current.baseRefName !== "develop") continue;
        // A queued reason can become stale without a new commit (labels, review, or draft).
        if (current.state === "OPEN" && (update.pr.state !== "OPEN"
          || snapshot(current) !== snapshot(update.pr))) continue;
        await postMergeDecisionComment({ github, context, ...update, pr: current });
      } catch (error) {
        core.warning(`PR #${update.pr.number}: could not update the merge notice: ${error.message}`);
      }
    }
    notices.clear();
  };
  const clearMergeRequest = async number => {
    try {
      await github.rest.issues.removeLabel({ owner, repo, issue_number: number, name: "needs-merge" });
    } catch (error) {
      if (error.status !== 404) {
        report(number, `merged, but needs-merge cleanup failed: ${error.message}`);
        await flushNotices();
        throw error;
      }
    }
    report(number, "merged; needs-merge request cleared.");
  };
  let openPulls;
  // ponytail: listCommits stops at 250 commits per PR; enough for stacked feature branches.
  const commitsOf = async number => (await github.paginate(github.rest.pulls.listCommits,
    { owner, repo, pull_number: number, per_page: 100 })).map(commit => commit.sha);
  const stackedOn = async number => {
    openPulls ??= await github.paginate(github.rest.pulls.list, { owner, repo, state: "open", base: "develop", per_page: 100 });
    const own = new Set(await commitsOf(number));
    const carried = [];
    for (const other of openPulls.filter(other => other.number !== number)) {
      if ((await commitsOf(other.number)).some(sha => own.has(sha))) carried.push(other.number);
    }
    return carried;
  };
  const candidates = context.payload.pull_request
    ? [context.payload.pull_request]
    : await github.paginate(github.rest.pulls.list, { owner, repo, state: "open", base: "develop", per_page: 100 });

  for (const candidate of candidates) {
    // Event labels can be stale after queuing; always read the affected PR again.
    if (!context.payload.pull_request
      && !candidate.labels?.some(label => label.name === "needs-merge")) continue;
    const pr = await read(candidate.number);
    // Resolve an earlier pending comment when a PR was merged manually or by a prior run.
    if (pr?.state === "MERGED") notice(pr, "Merged.", false);
    if (pr?.state === "CLOSED") notice(pr, "Closed without merging.", false);
    // A rerun after a cleanup failure must not attempt the merge a second time.
    if (pr?.state === "MERGED" && pr.baseRefName === "develop"
      && pr.labels.nodes.some(label => label.name === "needs-merge")) {
      await clearMergeRequest(pr.number);
      continue;
    }
    if (pr?.state === "OPEN" && !pr.labels.pageInfo?.hasNextPage
      && !pr.labels.nodes.some(label => label.name === "needs-merge")) {
      report(pr.number, "no needs-merge request is active; skipping merge evaluation.");
      continue;
    }
    const reason = blocker(pr);
    if (reason) {
      report(candidate.number, reason);
      if (pr?.state === "OPEN") notice(pr, `Merge pending: ${reason}`);
      continue;
    }

    // Inspect the actual CI workflow, not an arbitrary check named "verify".
    // Octokit paginate already unwraps each workflow_runs page into this array.
    const runs = await ciGithub.paginate(ciGithub.rest.actions.listWorkflowRuns, {
      owner, repo, workflow_id: "ci.yml", event: "pull_request", head_sha: pr.headRefOid, per_page: 100,
    });
    const latest = runs.filter(run => run.head_sha === pr.headRefOid && run.event === "pull_request")
      .sort((a, b) => b.id - a.id)[0];
    if (!latest || latest.status !== "completed" || latest.conclusion !== "success") {
      report(pr.number, latest
        ? `waiting for CI run ${latest.id}: ${latest.status}/${latest.conclusion ?? "pending"}.`
        : "waiting for a CI pull-request run on the current head.");
      notice(pr, !latest || latest.status !== "completed"
        ? "Merge pending: waiting for CI on the current commit."
        : `Merge pending: CI ${latest.conclusion ?? "did not pass"}. Please fix or rerun it.`);
      continue;
    }
    if (pr.mergeStateStatus !== "CLEAN") {
      report(pr.number, `waiting for GitHub merge requirements (merge state: ${pr.mergeStateStatus}).`);
      notice(pr, pr.mergeStateStatus === "DIRTY"
        ? "Merge pending: resolve the merge conflicts."
        : `Merge pending: GitHub merge requirements are not met (${pr.mergeStateStatus}).`);
      continue;
    }

    // Re-read after CI lookup so blocking labels, a removed request or a changed review stop merging.
    const current = await read(pr.number);
    const currentReason = blocker(current);
    if (currentReason) {
      report(pr.number, currentReason);
      if (current?.state === "OPEN") notice(current, `Merge pending: ${currentReason}`);
      continue;
    }
    if (current.headRefOid !== pr.headRefOid || current.mergeStateStatus !== "CLEAN") {
      report(pr.number, "head or merge requirements changed; waiting for the next evaluation.");
      notice(current, "Merge pending: the commit or merge requirements changed. Rechecking soon.");
      continue;
    }
    // A squash rewrites every commit on the branch. If the branch is stacked on another open
    // PR, that PR's work would land under this title and the lower PR would be left open with
    // conflicts and no journal entry. Merge the lower PR first.
    const carried = await stackedOn(pr.number);
    if (carried.length) {
      const list = carried.map(number => `#${number}`).join(", ");
      report(pr.number, `branch carries commits of open PR ${list}; merge that first.`);
      notice(current, `Merge pending: this branch also carries the commits of ${list}. Merge ${list} first, or rebase this branch onto develop without them.`);
      continue;
    }
    try {
      const { data } = await github.rest.pulls.merge({
        owner, repo, pull_number: pr.number, sha: pr.headRefOid, merge_method: "squash",
        commit_title: `${current.title} (#${pr.number})`,
      });
      if (!data.merged) throw new Error(data.message ?? `PR #${pr.number} was not merged.`);
      report(pr.number, `squash merged: ${data.sha}`);
      notice(current, "Merged.", false);
    } catch (error) {
      // Head changes, conflicts and newly unmet rules are retried on the next event.
      if ([405, 409].includes(error.status)) {
        report(pr.number, error.message);
        notice(current, "Merge pending: GitHub declined the merge. Rechecking the current requirements soon.");
      }
      else throw error;
      continue;
    }
    await clearMergeRequest(pr.number);
  }

  await flushNotices();

  if (core.summary) {
    await core.summary.addHeading("Merge decisions")
      .addList(messages.length ? messages : ["No open develop PRs have an active needs-merge request."])
      .write();
  }
}
