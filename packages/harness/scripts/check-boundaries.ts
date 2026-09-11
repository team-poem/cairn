/** Enforce package dependency direction without executing the imported modules. */
import { builtinModules } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export interface BoundaryViolation {
  file: string;
  line: number;
  specifier: string;
  rule: "cli-public-api" | "core-dependencies" | "engine-to-cli" | "harness-to-qa" | "literal-module-specifier";
}

const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const moduleName = (path: string) => path.replace(/(?:\.d)?\.(?:[cm]?[jt]sx?)$/, "");
const isCli = (path: string) => /^cli(?:$|[-/])/.test(moduleName(path));
const isCore = (path: string) => path.startsWith("core/");
const isPublic = (path: string) => ["index", "browser"].includes(moduleName(path));
const isQaPackage = (name: string) => /^(?:@cairn\/qa|cairn-qa)(?:\/|$)/.test(name);
const normalized = (path: string) => path.replaceAll("\\", "/");

type ResolveImport = (specifier: string, file: string) => string | undefined;

/** Analyze syntax, including imports inside function bodies and TypeScript type imports. */
export function analyzeSource(
  file: string,
  code: string,
  sourceRoot: string,
  resolveImport?: ResolveImport,
): BoundaryViolation[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const from = normalized(relative(sourceRoot, file));
  const violations: BoundaryViolation[] = [];
  const report = (node: ts.Node, specifier: string, rule: BoundaryViolation["rule"]) => {
    violations.push({ file: from, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, specifier, rule });
  };

  function check(node: ts.Node, argument: ts.Node | undefined): void {
    if (!argument || !ts.isStringLiteralLike(argument)) {
      report(node, argument?.getText(source) ?? "<missing>", "literal-module-specifier");
      return;
    }
    const specifier = argument.text;
    const selfImport = specifier === "cairn-engine" || specifier.startsWith("cairn-engine/");
    // Resolve tsconfig aliases and package imports in the real tree. The relative fallback also
    // checks nonexistent paths: a typo must not make a forbidden dependency acceptable.
    const target = selfImport
      ? resolve(sourceRoot, specifier === "cairn-engine" ? "index.ts" : specifier.slice("cairn-engine/".length))
      : resolveImport?.(specifier, file)
        ?? (specifier.startsWith(".") || isAbsolute(specifier) ? resolve(dirname(file), specifier) : undefined);
    const packageTarget = target ? normalized(relative(dirname(sourceRoot), target)) : undefined;
    const owned = packageTarget !== undefined && packageTarget !== ".."
      && !packageTarget.startsWith("../") && !isAbsolute(packageTarget);
    // Node #imports and tsconfig aliases can resolve to emitted declarations. They remain
    // engine-owned; dist/run.d.ts is not an external dependency or a public entry point.
    const to = owned ? packageTarget.replace(/^(?:src|dist)\//, "")
      : target ? normalized(relative(sourceRoot, target)) : undefined;
    const qaRoot = resolve(sourceRoot, "../../qa");
    const qaRelative = target ? normalized(relative(qaRoot, target)) : undefined;
    if (isQaPackage(specifier) || (qaRelative !== undefined && !qaRelative.startsWith("../") && qaRelative !== ".." && !isAbsolute(qaRelative))) {
      report(node, specifier, "harness-to-qa");
    } else if (!isCli(from) && to !== undefined && isCli(to)) {
      report(node, specifier, "engine-to-cli");
    } else if (isCore(from) && (to === undefined || !isCore(to))) {
      report(node, specifier, "core-dependencies");
    } else if (isCli(from)) {
      // Node builtins and third-party CLI dependencies are allowed; engine code is accessible
      // only through its two public entry points, alongside the CLI's own modules.
      const builtin = specifier.startsWith("node:") || builtins.has(specifier);
      const local = selfImport || specifier.startsWith(".") || isAbsolute(specifier) || owned;
      if (!builtin && local && (to === undefined || (!isPublic(to) && !isCli(to)))) {
        report(node, specifier, "cli-public-api");
      }
    }
  }

  function visit(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      check(node, node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      check(node, node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      check(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : node.argument);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      check(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return violations;
}

/** Walk all engine/CLI source files; tests and built output are not architecture inputs. */
export function checkBoundaries(sourceRoot: string): BoundaryViolation[] {
  const configPath = ts.findConfigFile(sourceRoot, ts.sys.fileExists);
  const options = configPath
    ? ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, dirname(configPath)).options
    : { moduleResolution: ts.ModuleResolutionKind.NodeNext };
  const resolveImport: ResolveImport = (specifier, file) =>
    ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule?.resolvedFileName;
  function walk(directory: string): BoundaryViolation[] {
    return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
      const file = resolve(directory, entry.name);
      if (entry.isDirectory()) return walk(file);
      return /\.[cm]?[jt]sx?$/.test(entry.name)
        ? analyzeSource(file, readFileSync(file, "utf8"), sourceRoot, resolveImport)
        : [];
    });
  }
  return walk(sourceRoot);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const violations = checkBoundaries(fileURLToPath(new URL("../src", import.meta.url)));
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}: ${violation.rule}: ${violation.specifier}`);
  }
  if (violations.length) process.exitCode = 1;
  else console.log("Dependency boundaries passed (CLI public API, core, engine, harness → qa).");
}
