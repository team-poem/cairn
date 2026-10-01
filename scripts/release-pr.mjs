/** Keep human release notes intact on refresh; a closed PR is not returned by this lookup. */
export async function ensureReleasePullRequest({ github, repo, version, previous, standingDays, standingLast }) {
  if (![version, previous].every(value => /^\d+\.\d+\.\d+$/.test(value ?? ""))) {
    throw new Error("Release and previous versions are required");
  }
  const { data: open } = await github.rest.pulls.list({ ...repo, base: "main", head: `${repo.owner}:develop`, state: "open" });
  if (open.length) return { number: open[0].number, created: false };
  const body = [
    "Prepared by `Prepare release`. The version bump, release entry and journal archive are on develop.", "",
    `Write the release notes here before merging. Merging publishes ${version} to npm, pushes the tag and drafts the GitHub release.`, "",
    `\`spec/journal/state.md\` was last touched ${standingDays} days ago, on ${standingLast}. Review it if a standing decision changed.`, "",
    `Full diff: https://github.com/${repo.owner}/${repo.repo}/compare/v${previous}...develop`,
  ].join("\n");
  const { data: created } = await github.rest.pulls.create({ ...repo, base: "main", head: "develop", title: `Release cairn-engine ${version}`, body, draft: true });
  return { number: created.number, created: true };
}
