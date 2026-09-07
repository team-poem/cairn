// file: packages/harness/test/dependency-boundaries.test.ts
import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { analyzeSource, checkBoundaries } from "../scripts/check-boundaries.js";

const root = "/fixture/packages/harness/src";
const inspect = (file: string, code: string) => analyzeSource(`${root}/${file}`, code, root);

test("cliPublicBoundary: CLI accepts public entries and its own args, rejects engine internals", () => {
  expect(inspect("cli.ts", 'import { discover } from "./index.js"; import type { Scenario } from "cairn-engine/browser"; import { parseArgs } from "./cli-args.js"; import "node:fs";')).toEqual([]);
  for (const specifier of ["./core/discover/index.js", "./adapters/drivers/chrome.js", "./run.js", "./suite.js", "./version.js", "cairn-engine/core/types"]) {
    expect(inspect("cli.ts", `import "${specifier}";`)).toHaveLength(1);
  }
});

test("coreDependencyDirection: core retains only core dependencies", () => {
  expect(inspect("core/pipeline.ts", 'import type { Driver } from "./ports.js";')).toEqual([]);
  for (const specifier of ["../version.js", "../adapters/drivers/chrome.js", "../cli.js", "../cli-args.js", "../run.js", "../suite.js", "../index.js", "../browser.js", "cairn-engine", "@modelcontextprotocol/sdk"]) {
    expect(inspect("core/pipeline.ts", `import "${specifier}";`)).toHaveLength(1);
  }
});

test("engineNeverImportsCli: engine cannot depend on CLI code by path or package subpath", () => {
  for (const file of ["index.ts", "browser.ts", "run.ts", "suite.ts", "adapters/reporters/console.ts"]) {
    const prefix = file.startsWith("adapters/") ? "../../" : "./";
    for (const target of ["cli.js", "cli-args.js", "cli/format.js"]) {
      expect(inspect(file, `export * from "${prefix}${target}";`)).toHaveLength(1);
    }
    expect(inspect(file, 'import "cairn-engine/cli";')).toHaveLength(1);
  }
  expect(inspect("adapters/drivers/chrome.ts", 'import type { Driver } from "../../core/ports.js";')).toEqual([]);
});

test("harnessNeverImportsQa: harness cannot reach the QA app through relative or package imports", () => {
  for (const specifier of ["../../qa/src/index.js", "@cairn/qa", "@cairn/qa/driver", "cairn-qa"]) {
    expect(inspect("run.ts", `import "${specifier}";`)).toHaveLength(1);
  }
  expect(inspect("run.ts", 'import { runHarness } from "./core/pipeline.js";')).toEqual([]);
});

test("boundarySyntaxCoverage: parser checks static, type, dynamic, re-export and require edges", () => {
  const forbidden = "../adapters/drivers/chrome.js";
  const forms = [
    `import { x } from "${forbidden}";`,
    `import type { X } from "${forbidden}";`,
    `import "${forbidden}";`,
    `export { x } from "${forbidden}";`,
    `export * from "${forbidden}";`,
    `export type { X } from "${forbidden}";`,
    `const x = import("${forbidden}");`,
    'const x = import(`../adapters/drivers/chrome.js`);',
    `const x = require("${forbidden}");`,
    `import x = require("${forbidden}");`,
    `type X = import("${forbidden}").X;`,
    `import { x }
from
"../adapters/drivers/chrome.js";`,
  ];
  for (const code of forms) expect(inspect("core/pipeline.ts", code)).toHaveLength(1);
  for (const code of forms) expect(inspect("core/pipeline.ts", code.replaceAll(forbidden, "./types.js"))).toEqual([]);
  expect(inspect("core/pipeline.ts", `// import "../adapters/no.js";
const text = 'require("../adapters/no.js")';`)).toEqual([]);
  expect(inspect("core/pipeline.ts", "")).toEqual([]);
});

test("nodeBuiltinsAndComputedImports: core rejects prefixed and bare Node imports and uncheckable edges", () => {
  for (const specifier of ["node:fs", "fs/promises", "path", "node:test"]) {
    expect(inspect("core/pipeline.ts", `import "${specifier}";`)).toHaveLength(1);
  }
  for (const file of ["core/pipeline.ts", "cli.ts", "run.ts"]) {
    expect(inspect(file, 'const name = "./core/types.js"; import(name);')).toHaveLength(1);
    expect(inspect(file, 'require(`./${name}.js`);')).toHaveLength(1);
  }
  expect(inspect("adapters/skills/file-store.ts", 'import "node:fs/promises";')).toEqual([]);
});

test("boundaryDiagnosticLocation: failures name the importing file, line, edge and rule", () => {
  const [violation] = inspect("cli.ts", `

import "./run.js";`);
  expect(violation).toMatchObject({ file: "cli.ts", line: 3, specifier: "./run.js", rule: "cli-public-api" });
});

test("repositoryDependencyBoundary: the shipped source tree respects every dependency rule", () => {
  const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
  expect(checkBoundaries(sourceRoot)).toEqual([]);
});

test("packageImportAliases: resolved declarations inside the package keep engine and CLI boundaries", () => {
  const sourceRoot = "/fixture/packages/harness/src";
  const resolveImport = (specifier: string) => `/fixture/packages/harness/dist/${specifier.slice(1)}.d.ts`;
  expect(analyzeSource(`${sourceRoot}/cli.ts`, 'import "#run";', sourceRoot, resolveImport))
    .toEqual([expect.objectContaining({ rule: "cli-public-api", specifier: "#run" })]);
  expect(analyzeSource(`${sourceRoot}/run.ts`, 'import "#cli";', sourceRoot, resolveImport))
    .toEqual([expect.objectContaining({ rule: "engine-to-cli", specifier: "#cli" })]);
  expect(analyzeSource(`${sourceRoot}/cli.ts`, 'import "#index";', sourceRoot, resolveImport)).toEqual([]);
  expect(analyzeSource(`${sourceRoot}/core/pipeline.ts`, 'import "#run";', sourceRoot, resolveImport))
    .toEqual([expect.objectContaining({ rule: "core-dependencies" })]);
});

test("publicDiagnosticBoundary: exposes engine diagnostics without presentation-only suite labels", async () => {
  const engine = await import("../src/index.js");
  expect(engine).not.toHaveProperty("unprovenLabel");
  expect(engine).not.toHaveProperty("navigationEvidenceLabel");
  for (const diagnostic of [engine.describeAction, engine.provesAnAction, engine.hasSemanticCriterion, engine.droppedProofReason]) {
    expect(diagnostic).toBeTypeOf("function");
  }
});
