import assert from "node:assert/strict";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const root = fileURLToPath(new URL(".", import.meta.url));
const artifacts = resolve(root, process.env.DEMO_OUTPUT ?? ".artifacts");
const dist = resolve(root, "dist");
const manifest = JSON.parse(
  await readFile(resolve(artifacts, "manifest.json"), "utf8"),
);
assert.equal(
  manifest.complete,
  true,
  "Only a complete verified recording can be built",
);
assert.equal(manifest.stages.length, 6);
assert.ok(manifest.engine?.archive, "Recording must preserve its exact engine build");
assert.equal(
  createHash("sha256").update(await readFile(resolve(artifacts, manifest.engine.archive))).digest("hex"),
  manifest.engine.sha256,
  "Recorded engine archive changed",
);
for (const [path, expected] of Object.entries(manifest.sourceHashes)) {
  const actual = createHash("sha256")
    .update(await readFile(resolve(root, path)))
    .digest("hex");
  assert.equal(
    actual,
    expected,
    `${path} changed after recording; record again before publishing`,
  );
}
for (const stage of manifest.stages) {
  assert.equal(stage.status, "recorded");
  for (const file of [
    stage.scenario,
    stage.trace,
    ...stage.frames.map((frame) => frame.image).filter(Boolean),
  ]) {
    assert.ok(file && resolve(artifacts, file).startsWith(artifacts + "/"));
    await readFile(resolve(artifacts, file));
  }
}
await rm(dist, { recursive: true, force: true });
await mkdir(dist);
await cp(resolve(root, "public"), resolve(dist, "public"), { recursive: true });
await cp(artifacts, resolve(dist, ".artifacts"), { recursive: true });
await cp(resolve(root, "server.mjs"), resolve(dist, "server.mjs"));
await cp(resolve(root, "record.mjs"), resolve(dist, "record.mjs"));
await writeFile(
  resolve(dist, "package.json"),
  JSON.stringify(
    {
      private: true,
      type: "module",
      scripts: { start: "node server.mjs" },
      engines: { node: ">=22.12" },
    },
    null,
    2,
  ),
);

// Export runnable source with the exact installed engine, including a workspace build.
// The deployed viewer needs only Node; it never hosts a model or browser process.
const source = resolve(dist, "public/source/order-demo");
await mkdir(source, { recursive: true });
await cp(resolve(artifacts, manifest.engine.archive), resolve(source, manifest.engine.archive));
for (const path of [
  "record.mjs",
  "server.mjs",
  "server.test.mjs",
  "README.md",
  "public",
]) {
  await cp(resolve(root, path), resolve(source, path), { recursive: true });
}
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
delete pkg.scripts.build;
pkg.dependencies["cairn-engine"] = `file:./${manifest.engine.archive}`;
await writeFile(resolve(source, "package.json"), JSON.stringify(pkg, null, 2));
execFileSync("tar", [
  "-czf",
  resolve(dist, ".artifacts/source.tar.gz"),
  "-C",
  dirname(source),
  "order-demo",
]);
await cp(
  resolve(dist, ".artifacts/source.tar.gz"),
  resolve(artifacts, "source.tar.gz"),
);
await rm(source, { recursive: true, force: true });
console.log(`Verified deployable Node site: ${dist}`);
