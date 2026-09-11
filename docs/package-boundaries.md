# Package boundaries

`cairn-engine` ships the engine and the `cairn` CLI as one npm package. The public entries are
`cairn-engine` and `cairn-engine/browser`, and the existing exports, types and bin path are kept.
Splitting the package or reducing install dependencies is outside the scope of this check.

The CLI consumes the engine only through `./index.js`, so running from source (`tsx src/cli.ts`) and
running the built output (`dist/cli.js`) use the same public Node entry. The argument parser and the
CLI's display wording belong to the CLI. When embedding the engine, import a public entry and never
an internal `src/` or `dist/core/` path.

`npm run check:boundaries` uses the TypeScript parser to inspect every source file's static imports,
type imports, re-exports, dynamic imports, direct `require()` calls and `import = require()` forms.
Example code inside strings and comments is not a dependency. A computed module path cannot be
checked statically, so it is rejected. Real sources are resolved with the tsconfig's module
resolution. A package `#imports` alias that resolves to `dist/*.d.ts` is still classified as an
internal file of the same package, so reaching an internal module through an alias, or the CLI being
reached in reverse, is rejected too.

- The CLI reaches only public entries and CLI modules. Node builtins and the CLI's own external
  dependencies are allowed.
- `core/` depends only on other core modules. Version lookup (`version.ts`) belongs to the Node
  assembly layer. Core does not directly import adapters, the CLI, `run`, `suite`, the public barrel,
  external packages or Node builtins.
- The engine does not import the CLI. Adapters implement core's ports, and a reporter's existing
  reference to the suite result type is kept.
- The harness does not depend on the QA app. The `packages/qa` path and the `@cairn/qa` and
  `cairn-qa` names, including their subpaths, are rejected. Introducing a new QA package name means
  updating the check as well.

This check fixes the direct dependency direction. Browser compatibility and the completeness of the
published files are confirmed separately by the browser bundle and tarball consumer checks.

## Node diagnostic API

The following functions the CLI already used are re-exported from the public Node entry. They share
the existing implementation, so judgment logic is not duplicated into the CLI. The browser entry's
contract is unchanged.

| Function | Ownership and usage contract |
| --- | --- |
| `describeAction(decision)` | A short human-readable description of a `Decision`, owned by discovery. Use it in an embedder's progress log. |
| `provesAnAction(scenario)` | A diagnostic predicate owned by freeze. It checks for a non-vacuous `request-status` or `custom` assertion. It is not itself a verdict on the scenario. |
| `hasSemanticCriterion(scenario)` | Whether a non-vacuous `expect` assertion survives in the freeze, distinguishing a model-judged criterion from a mechanical proof. |
| `droppedProofReason(traceEvent)` | Why a grounding gate discarded a `request-status` assertion. It returns `undefined` for an unrelated event or malformed action JSON. |

The function names, types and the meanings above are a public API contract. The strings they return
are human-readable diagnostics, not a protocol whose exact wording should be parsed. For structured
handling, read the `TraceEvent`, `Scenario` and `SuiteVerdict` fields. None of these functions
introduces a new decision about success or about whether a freeze is kept.

The unproven-action and observed-destination warnings are formatted from public `SuiteVerdict` fields
by each display layer. The CLI and the Markdown reporter each keep their own private formatting
function, so neither duplicates engine judgment nor makes the reporter depend on the CLI.
