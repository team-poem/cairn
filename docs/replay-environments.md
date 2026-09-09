# Replay frozen scenarios in another environment

`replayEnvironment` moves a saved scenario to another origin for the current run.
The original object and skill file stay unchanged. Omitting the option preserves
normal replay behavior.

## CLI

```sh
cairn replay checkout.skill.json \
  --base-url http://localhost:3000 \
  --allowed-hosts shop.example.com,api.example.com,localhost:4000

cairn run --scenario checkout.skill.json \
  --base-url http://localhost:3000 \
  --allowed-hosts shop.example.com,api.example.com,localhost:4000
```

`--base-url` is the target origin: an HTTP(S) address with an optional trailing `/`.
Path prefixes, queries, fragments, and credentials are rejected. Existing page
paths are preserved.

`--allowed-hosts` lists source page hosts and API hosts permitted to match across
environments, separated by commas. In this example, pages on `shop.example.com`
move to localhost:3000, while request checks for `api.example.com` can match the
same endpoint on localhost:4000. The target origin's host is automatically
included in the request matching scope.

The scenario's first `goto` must belong to a declared source host or already use
the target origin. Otherwise configuration fails before browser or LLM work;
a misspelled host list cannot silently replay against the source environment.
Later external navigation steps remain unchanged.

Hosts are compared with their ports; subdomains are not implicitly allowed.
DNS case, internationalized names, and IPv6 spellings are normalized, while
explicit `:80` and `:443` scopes remain distinct.

## Library

```ts
import { loadSkillFile, runScenario } from "cairn-engine";

const scenario = await loadSkillFile("checkout.skill.json");
const { result } = await runScenario(scenario, {
  replayEnvironment: {
    baseUrl: "http://localhost:3000",
    allowedHosts: ["shop.example.com", "api.example.com", "localhost:4000"],
  },
});
```

A passing replay with only mechanical assertions makes no LLM calls. The normal
LLM requirements for natural-language `expect` assertions and healing still apply.

When combining this option with `secrets`, supply credentials scoped to the actual
target site (for example `origin: "http://localhost:3000"`). Environment mapping
does not rewrite or widen a secret's origin: a staging-scoped secret is still
refused on localhost. The frozen `{name}` placeholders stay unchanged.

## Suite cache reuse

```sh
cairn suite cases.json --skills ./skills \
  --replay-base-url http://localhost:3000 \
  --allowed-hosts shop.example.com,api.example.com,localhost:4000
```

The suite's existing `baseUrl` and CLI `--base-url` remain the canonical discovery
URL used in the cache fingerprint. To change only the replay environment, use
`--replay-base-url` or `runSuite(cases, { replayEnvironment: ... })`.

This mode only replays a current canonical cache. A missing or stale cache fails
the case without starting a browser, calling an LLM, discovering, or saving.
Reports identify it as not run and exclude it from the zero-LLM replay count.

## Transformation and storage boundaries

- Declared page hosts are remapped in every `goto.url`, step `expect.url`,
  `waitFor.until.url`, and `navigated.to`. Paths, queries, fragments, and wildcards
  survive. Host-only page destinations are remapped too: freeze stores a root
  destination such as `https://shop.example.com/` as `shop.example.com`.
- Request expectations remain frozen. Only when both expected and actual hosts
  are in scope can the matcher compare endpoint path prefixes and query subsets
  across hosts. HTTP method and status checks still apply. Host-only and root-only
  request expectations do not enable cross-host fallback.
- Later external URLs, custom params, target strings, and natural-language
  assertions remain unchanged. Custom code and reporters receive evidence from
  the actual execution environment.
- Healing can repair and judge the target run temporarily. `healedScenario` is
  withheld, and suites do not save the repair. Combining CLI `--freeze` with an
  environment is a usage error. After `--heal`, console and JSON output contain
  the final verdict and evidence, including any temporary repair.

Trace step and page-assertion URLs describe the runtime copy. Request expectation
strings remain canonical; observed URLs describe the target environment. The
canonical `skillRef` and `caseHash` are preserved. See the [trace contract](../spec/core/trace.md).

This option transforms frozen execution data. It does not rewrite application
links, redirects, or network traffic, or prevent access to external origins.
