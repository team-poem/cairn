import { createServer } from "node:http";
import { createHash } from "node:crypto";

export function fixtureInfo(tier, version) {
  return { hash: createHash("sha256").update(`${tier}:${version}`).digest("hex"), entryPath: "/", intent: "Click Continue to reach the destination" };
}

export function delayFor(latency, runIndex, routeClass) {
  const values = latency[routeClass];
  return values[runIndex % values.length];
}

export async function startFixture({ tier, version, runIndex, latency }) {
  let complete = false;
  const logs = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    logs.push({ path });
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (path === "/") res.end('<!doctype html><html lang="en"><title>Navigation</title><a href="/done">Continue</a></html>');
    else if (path === "/done") { complete = true; res.end("Destination reached"); }
    else { res.statusCode = 404; res.end("Not found"); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    snapshot: () => ({ complete }),
    requestLog: () => structuredClone(logs),
    close: () => new Promise((resolve, reject) => { server.close((error) => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()); server.closeAllConnections(); }),
  };
}
