const marker = "<!-- cairn-pingu-merge-decision -->";
const botLogin = "cairn-pingu[bot]";

// Keep one decision comment owned by the verified App, without reviving stale decisions.
export async function postMergeDecisionComment({ github, context, pr, message, createIfMissing = true }) {
  if (pr.baseRefName !== "develop") return;
  const { data: bot } = await github.rest.users.getByUsername({ username: botLogin });
  if (bot?.type !== "Bot" || bot.login !== botLogin || !Number.isSafeInteger(bot.id) || bot.id <= 0) {
    throw new Error("Could not verify the cairn-pingu GitHub App bot identity");
  }
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo, issue_number: pr.number, per_page: 100,
  });
  const existing = comments.find(comment => comment.user?.id === bot.id && comment.body?.startsWith(marker));
  const { data: current } = await github.rest.pulls.get({ ...context.repo, pull_number: pr.number });
  if (current.base.ref !== "develop" || current.head.sha !== pr.headRefOid) return;
  if (current.merged === true) {
    message = "Merged.";
    createIfMissing = false;
  } else if (current.state !== "open") {
    message = "Closed without merging.";
    createIfMissing = false;
  } else if (pr.state !== "OPEN") return;

  const body = `${marker}\n${message}`;
  if (existing?.body === body) return;
  if (existing) await github.rest.issues.updateComment({ ...context.repo, comment_id: existing.id, body });
  else if (createIfMissing) await github.rest.issues.createComment({ ...context.repo, issue_number: pr.number, body });
}
