const query = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number state isDraft baseRefName headRefOid title reviewDecision mergeStateStatus
      labels(first: 100) { nodes { name } pageInfo { hasNextPage } }
    }
  }
}`;

function blocker(pr) {
  if (!pr) return "pull request is unavailable.";
  const labels = pr.labels.nodes.map(label => label.name);
  if (labels.includes("no-merge")) return "blocked by no-merge; remove it before requesting a merge.";
  if (pr.labels.pageInfo?.hasNextPage) return "label list is incomplete; cannot rule out no-merge.";
  if (!labels.includes("needs-merge")) return "no needs-merge request is active.";
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
  const report = (number, message) => {
    const line = `PR #${number}: ${message}`;
    core.info(line);
    messages.push(line);
  };
  const read = async number => (await github.graphql(query, { owner, repo, number })).repository.pullRequest;
  const candidates = context.payload.pull_request
    ? [context.payload.pull_request]
    : await github.paginate(github.rest.pulls.list, { owner, repo, state: "open", base: "develop", per_page: 100 });

  for (const candidate of candidates) {
    // Event labels can be stale after queuing; always read the affected PR again.
    if (!context.payload.pull_request
      && !candidate.labels?.some(label => ["needs-merge", "no-merge"].includes(label.name))) continue;
    const pr = await read(candidate.number);
    const reason = blocker(pr);
    if (reason) {
      report(candidate.number, reason);
      continue;
    }

    // Inspect the actual CI workflow, not an arbitrary check named "verify".
    const runs = await ciGithub.paginate(ciGithub.rest.actions.listWorkflowRuns, {
      owner, repo, workflow_id: "ci.yml", event: "pull_request", head_sha: pr.headRefOid, per_page: 100,
    }, response => response.data.workflow_runs);
    const latest = runs.filter(run => run.head_sha === pr.headRefOid && run.event === "pull_request")
      .sort((a, b) => b.id - a.id)[0];
    if (!latest || latest.status !== "completed" || latest.conclusion !== "success") {
      report(pr.number, latest
        ? `waiting for CI run ${latest.id}: ${latest.status}/${latest.conclusion ?? "pending"}.`
        : "waiting for a CI pull-request run on the current head.");
      continue;
    }
    if (pr.mergeStateStatus !== "CLEAN") {
      report(pr.number, `waiting for GitHub merge requirements (merge state: ${pr.mergeStateStatus}).`);
      continue;
    }

    // Re-read after CI lookup so no-merge, a removed request or a changed review stops merging.
    const current = await read(pr.number);
    const currentReason = blocker(current);
    if (currentReason) {
      report(pr.number, currentReason);
      continue;
    }
    if (current.headRefOid !== pr.headRefOid || current.mergeStateStatus !== "CLEAN") {
      report(pr.number, "head or merge requirements changed; waiting for the next evaluation.");
      continue;
    }
    try {
      const { data } = await github.rest.pulls.merge({
        owner, repo, pull_number: pr.number, sha: pr.headRefOid, merge_method: "squash",
        commit_title: `${current.title} (#${pr.number})`,
      });
      if (!data.merged) throw new Error(data.message ?? `PR #${pr.number} was not merged.`);
      report(pr.number, `squash merged: ${data.sha}`);
    } catch (error) {
      // Head changes, conflicts and newly unmet rules are retried on the next event.
      if ([405, 409].includes(error.status)) report(pr.number, error.message);
      else throw error;
    }
  }

  if (core.summary) {
    await core.summary.addHeading("Merge decisions")
      .addList(messages.length ? messages : ["No open develop PRs have needs-merge or no-merge."])
      .write();
  }
}
