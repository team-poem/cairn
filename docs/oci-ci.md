# OCI verification

The `ci` workflow keeps its `verify` job and required-check identity. Same-repository
pull requests, pushes to `main` or `develop`, and manual runs dispatch verification
to the private `team-poem/oci-ci` repository. The GitHub-hosted relay waits for that
specific execution and succeeds only when it succeeds. The tested commit is the
pull request's merge commit, with its current head checked separately before work
starts. A stale head, failed execution, cancellation, timeout, or ambiguous result
fails the relay.

The private executor runs the existing boundary, language, journal, typecheck,
build, workspace-test, benchmark-contract, and demo-contract checks on
Ubuntu ARM64. No production deployment is performed.
The browser compatibility matrix, document-reference checks, package-consumer
matrix, and release workflows keep their existing execution environments.

Fork and Dependabot pull requests run the original `verify` commands on GitHub-hosted runners.
They receive no private-executor credential. No OCI runner is registered to this
public repository: changing a fork's `runs-on` cannot select one. A workflow-level
same-repository condition alone would not protect a public self-hosted runner.

The relay checks out the private executor at a reviewed commit pinned in
`.github/workflows/ci.yml`. Its existing GitHub App secrets must permit a token
restricted to `team-poem/oci-ci`, with Contents write for dispatch and Actions read
for result polling. The workflow's own `GITHUB_TOKEN` remains read-only, and
checkout credentials are not persisted.

Host setup, resource management, and cleanup are documented in the private
executor repository. No host credentials are stored in this repository.

The relay job has a 60-minute timeout; its polling script waits up to 55 minutes.
Obsolete relay executions for the same workflow and ref are cancelled. Check the
linked private Actions run when diagnosing a failure.
Queue and host-lease waits consume the timeout budget. A repository reader without
access to the private executor can still see the public relay's final check result.
