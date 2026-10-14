export function mergeLabelBlocker(pr) {
  if (!pr) return "pull request is unavailable.";
  const labels = pr.labels.nodes.map(label => label.name);
  if (labels.includes("no-merge")) return "blocked by no-merge; remove it before requesting a merge.";
  if (labels.includes("status/1-needs-review")) return "blocked by status/1-needs-review; a maintainer must remove it before requesting a merge.";
  if (pr.labels.pageInfo?.hasNextPage) return "label list is incomplete; cannot rule out no-merge or status/1-needs-review.";
  if (!labels.includes("needs-merge")) return "no needs-merge request is active.";
  return null;
}

const query = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number state baseRefName headRefOid
      labels(first: 100) { nodes { name } pageInfo { hasNextPage } }
    }
  }
}`;

// A normal pull_request job supplies the required check on the tested PR revision.
// This evaluator only reads metadata; it never changes labels or merges a PR.
export async function checkMergeLabelPolicy({ github, context, core }) {
  const { owner, repo } = context.repo;
  const event = context.payload.pull_request;
  if (!event?.number || !event.head?.sha) throw new Error("A pull-request head is required.");
  const sha = event.head.sha;
  const read = async number => (await github.graphql(query, { owner, repo, number })).repository.pullRequest;
  const messages = [];
  for (const stage of ["initial", "final"]) {
    const candidates = await github.paginate(github.rest.pulls.list, {
      owner, repo, state: "open", base: "develop", per_page: 100,
    });
    // Checks belong to commits. Re-enumerate before success so a newly opened PR
    // sharing this SHA cannot inherit permission while its own labels block it.
    const numbers = [...new Set([event.number, ...candidates
      .filter(pr => pr.head.sha === sha).map(pr => pr.number)])];
    for (const number of numbers) {
      const pr = await read(number);
      let reason = mergeLabelBlocker(pr);
      if (!reason && (pr.state !== "OPEN" || pr.baseRefName !== "develop" || pr.headRefOid !== sha)) {
        reason = "pull request state, base, or head changed; wait for its current check.";
      }
      if (reason) messages.push(`PR #${number} (${stage} check): ${reason}`);
    }
    if (messages.length) break;
  }
  if (messages.length) core.setFailed(messages.join("\n"));
  else core.info(`Merge labels allow head ${sha}; approval and CI are still required.`);
  if (core.summary) {
    await core.summary.addHeading("Merge label policy")
      .addList(messages.length ? messages : ["needs-merge is present; no blocking review or no-merge label remains."])
      .write();
  }
}
