import assert from "node:assert/strict";
import path from "node:path";

// Use relative paths so drive letters and separators follow the host platform.
export function resolveArtifact(root, file, paths = path) {
  assert.ok(typeof file === "string" && file.length > 0, "Artifact path is required");
  const resolved = paths.resolve(root, file);
  const relative = paths.relative(root, resolved);
  assert.ok(
    relative && relative !== ".." &&
      !relative.startsWith(".." + paths.sep) && !paths.isAbsolute(relative),
    "Artifact must be inside the recording directory",
  );
  return resolved;
}
