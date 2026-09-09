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
  let savedValue = null;
  const logs = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    logs.push({ path });
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (tier === "form" && path === "/api/save" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let value;
      try { value = JSON.parse(body).value; } catch { /* invalid input */ }
      if (typeof value !== "string" || !value.trim()) { res.statusCode = 400; res.end("A value is required"); return; }
      savedValue = value;
      complete = value === "alice";
      res.end(JSON.stringify({ saved: value }));
      return;
    }
    if (tier === "form" && path === "/") {
      res.end(`<!doctype html><html lang="en"><title>Async form</title><form><label>Name <input name="value"></label><button>Save</button></form><p role="status"></p><script>
        document.querySelector('form').onsubmit = async (event) => { event.preventDefault(); const response = await fetch('/api/save', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({value:document.querySelector('input').value})}); document.querySelector('[role=status]').textContent = response.ok ? 'Saved' : 'Error'; };
      </script></html>`);
      return;
    }
    if (path === "/") res.end('<!doctype html><html lang="en"><title>Navigation</title><a href="/done">Continue</a></html>');
    else if (path === "/done") { complete = true; res.end("Destination reached"); }
    else { res.statusCode = 404; res.end("Not found"); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    snapshot: () => ({ complete, savedValue }),
    requestLog: () => structuredClone(logs),
    close: () => new Promise((resolve, reject) => { server.close((error) => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()); server.closeAllConnections(); }),
  };
}
