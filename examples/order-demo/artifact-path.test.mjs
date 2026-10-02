import assert from "node:assert/strict";
import { test } from "node:test";
import { posix, win32 } from "node:path";
import { resolveArtifact } from "./artifact-path.mjs";

for (const [name, paths, root] of [
  ["POSIX", posix, "/demo/.artifacts"],
  ["Windows", win32, "C:\\demo\\.artifacts"],
]) {
  test(name + " accepts recording files and rejects paths outside the directory", () => {
    for (const file of ["replay/trace.jsonl", "replay/frame.png", "..notes/trace.jsonl",
      paths.join(root, "replay", "trace.jsonl")]) {
      assert.equal(resolveArtifact(root, file, paths), paths.resolve(root, file));
    }
    for (const file of ["", ".", "..", "../secret", "../.artifacts-other/trace.jsonl",
      paths.resolve(root, "../outside")]) {
      assert.throws(() => resolveArtifact(root, file, paths));
    }
    if (name === "Windows") {
      assert.equal(resolveArtifact(root, "replay\\trace.jsonl", paths), paths.join(root, "replay", "trace.jsonl"));
      assert.throws(() => resolveArtifact(root, "D:\\trace.jsonl", paths));
      assert.throws(() => resolveArtifact(root, "..\\secret", paths));
    }
  });
}
