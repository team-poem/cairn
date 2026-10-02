import "./build.mjs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// build.mjs verifies the original recording and its source/engine hashes first.
const root = fileURLToPath(new URL(".", import.meta.url));
const dist = resolve(root, "dist");
const output = resolve(root, ".vercel-site");
const project = await readFile(resolve(output, ".vercel/project.json"), "utf8").catch((error) => {
  if (error.code !== "ENOENT") throw error;
  return undefined;
});
await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "api"), { recursive: true });
await cp(resolve(dist, "public"), resolve(output, "public"), { recursive: true });
await cp(resolve(dist, ".artifacts"), resolve(output, "public/recording"), { recursive: true });
await mkdir(resolve(output, "lib"));
await cp(resolve(root, "server.mjs"), resolve(output, "lib/server.mjs"));
await cp(resolve(root, "record.mjs"), resolve(output, "public/source/record.mjs"));
for (const name of ["order", "config"]) {
  const source = await readFile(resolve(root, `vercel/${name}.mjs`), "utf8");
  await writeFile(resolve(output, `api/${name}.mjs`), source.replace('"../server.mjs"', '"../lib/server.mjs"'));
}
await writeFile(resolve(output, "package.json"), JSON.stringify({ private: true, type: "module", engines: { node: "24.x" } }, null, 2));
await writeFile(resolve(output, "vercel.json"), JSON.stringify({
  routes: [
    { src: "/recording/(.*)", headers: { "X-Content-Type-Options": "nosniff" }, continue: true },
    { handle: "filesystem" },
    { src: "/shop(?:/.*)?", dest: "/shop/index.html" },
  ],
}, null, 2));
if (project) {
  await mkdir(resolve(output, ".vercel"));
  await writeFile(resolve(output, ".vercel/project.json"), project);
}
console.log(`Verified Vercel deployment source: ${output}`);
