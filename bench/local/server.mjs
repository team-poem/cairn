import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";

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
  const sessions = new Map();
  const logs = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    logs.push({ path });
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (tier === "stateful") {
      const token = /(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
      const session = sessions.get(token);
      let body = {};
      if (req.method === "POST") {
        try { let raw = ""; for await (const chunk of req) raw += chunk; body = JSON.parse(raw); }
        catch { res.statusCode = 400; res.end("Invalid input"); return; }
      }
      if (path === "/api/login" && req.method === "POST") {
        if (body.username !== "alice") { res.statusCode = 400; res.end("Use alice"); return; }
        const id = randomUUID();
        sessions.set(id, { cartCount: 0, orderCount: 0 });
        res.setHeader("set-cookie", `session=${id}; HttpOnly; SameSite=Strict; Path=/`);
        res.end("Logged in"); return;
      }
      if (path === "/login") {
        res.end(`<!doctype html><html lang="en"><title>Login</title><form><label>Username <input></label><button>Log in</button></form><script>document.querySelector('form').onsubmit=async(e)=>{e.preventDefault();const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:document.querySelector('input').value})});if(r.ok)location.href='/products';};</script></html>`); return;
      }
      if (!session) { res.statusCode = 401; res.end("Log in first"); return; }
      if (path === "/products") {
        res.end(`<!doctype html><html lang="en"><title>Products</title><button>Add to cart</button><a href="/cart">Cart</a><p role="status"></p><script>document.querySelector('button').onclick=async()=>{await fetch('/api/cart',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sku:'book',quantity:1})});document.querySelector('[role=status]').textContent='Added';};</script></html>`); return;
      }
      if (path === "/api/cart" && req.method === "POST") {
        if (body.sku !== "book" || body.quantity !== 1) { res.statusCode = 400; res.end("Expected one book"); return; }
        session.cartCount++; res.end("Added"); return;
      }
      if (path === "/cart") {
        res.end(`<!doctype html><html lang="en"><title>Cart</title><p>Books: ${session.cartCount}</p><button>Place order</button><script>document.querySelector('button').onclick=async()=>{const r=await fetch('/api/order',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});if(r.ok)location.href='/done';};</script></html>`); return;
      }
      if (path === "/api/order" && req.method === "POST") {
        if (session.cartCount !== 1 || session.orderCount) { res.statusCode = 409; res.end("A new one-book cart is required"); return; }
        session.orderCount++; res.end("Ordered"); return;
      }
      if (path === "/done" && session.orderCount === 1) { complete = true; res.end("Order complete"); return; }
      res.statusCode = 404; res.end("Not found"); return;
    }
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
    else if (tier === "navigation" && path === "/done") { complete = true; res.end("Destination reached"); }
    else { res.statusCode = 404; res.end("Not found"); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    snapshot: () => ({ complete, savedValue, cartCount: [...sessions.values()].reduce((n, s) => n + s.cartCount, 0), orderCount: [...sessions.values()].reduce((n, s) => n + s.orderCount, 0) }),
    requestLog: () => structuredClone(logs),
    close: () => new Promise((resolve, reject) => { server.close((error) => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()); server.closeAllConnections(); }),
  };
}
