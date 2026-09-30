const query = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number state isDraft baseRefName headRefOid title reviewDecision mergeStateStatus
      labels(first: 100) { nodes { name } }
    }
  }
}`;

function ready(pr) {
  return pr.state === "OPEN" && !pr.isDraft && pr.baseRefName === "develop"
    && pr.labels.nodes.some(label => label.name === "needs-merge")
    && pr.reviewDecision === "APPROVED" && pr.mergeStateStatus === "CLEAN";
}

// The App can bypass rulesets, so approval and CI must be checked explicitly.
// Use GitHub's squash API: GitHub credits the PR author and records the App as merger.
export async function mergeLabeledPullRequests({ github, ciGithub = github, context, core }) {
  const { owner, repo } = context.repo;
  const read = async number => (await github.graphql(query, { owner, repo, number })).repository.pullRequest;
  const candidates = context.payload.pull_request
    ? [context.payload.pull_request]
    : await github.paginate(github.rest.pulls.list, { owner, repo, state: "open", base: "develop", per_page: 100 });

  for (const candidate of candidates) {
    if (!candidate.labels?.some(label => label.name === "needs-merge")) continue;
    const pr = await read(candidate.number);
    if (!pr || !ready(pr)) {
      core.info(`PR #${candidate.number}: waiting for needs-merge label, approval and merge requirements.`);
      continue;
    }

    // Inspect the actual CI workflow, not an arbitrary check named "verify".
    const runs = await ciGithub.paginate(ciGithub.rest.actions.listWorkflowRuns, {
      owner, repo, workflow_id: "ci.yml", event: "pull_request", head_sha: pr.headRefOid, per_page: 100,
    }, response => response.data.workflow_runs);
    const latest = runs.filter(run => run.head_sha === pr.headRefOid && run.event === "pull_request")
      .sort((a, b) => b.id - a.id)[0];
    if (!latest || latest.status !== "completed" || latest.conclusion !== "success") {
      core.info(`PR #${pr.number}: waiting for the latest CI run to pass.`);
      continue;
    }

    // Re-read after CI lookup so a removed label or changed review cancels the request.
    const current = await read(pr.number);
    if (!current || !ready(current) || current.headRefOid !== pr.headRefOid) continue;
    try {
      const { data } = await github.rest.pulls.merge({
        owner, repo, pull_number: pr.number, sha: pr.headRefOid, merge_method: "squash",
        commit_title: `${current.title} (#${pr.number})`,
      });
      if (!data.merged) throw new Error(data.message ?? `PR #${pr.number} was not merged.`);
      core.info(`Squash merged PR #${pr.number}: ${data.sha}`);
    } catch (error) {
      // Head changes, conflicts and newly unmet rules are retried on the next event.
      if ([405, 409].includes(error.status)) core.info(`PR #${pr.number}: ${error.message}`);
      else throw error;
    }
  }
}
