// file: bench/local-server.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { startFixture, delayFor, fixtureInfo, reservePort } from "./local/server.mjs";

/** Same shape as `request`, on a connection that is never pooled. Rebinding one port means the
 * global fetch pool can hand back a socket the previous server already closed, which fails before
 * the replacement server sees anything. A real run has no such client: each attempt drives a fresh
 * browser. */
function freshRequest(server, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const call = httpRequest(server.origin + path, {
      method: payload === null ? "GET" : "POST",
      agent: false,
      headers: { ...(payload === null ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }), ...(cookie ? { cookie } : {}) },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, cookie: response.headers["set-cookie"]?.[0]?.split(";")[0], text }));
    });
    call.once("error", reject);
    call.end(payload ?? undefined);
  });
}

const immediate = { document: [0], api: [0] };
async function fixture(t, options = {}) {
  const server = await startFixture({ tier: "navigation", version: "v1", runIndex: 0, latency: immediate, ...options });
  t.after(() => server.close());
  return server;
}
async function request(server, path, body, cookie) {
  const response = await fetch(server.origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, cookie: response.headers.get("set-cookie")?.split(";")[0], text };
}

test("localNavigationOracle: destination access completes a local navigation fixture", { timeout: 5000 }, async (t) => {
  const s = await fixture(t);
  assert.equal(new URL(s.origin).hostname, "127.0.0.1");
  assert.notEqual(new URL(s.origin).port, "0");
  assert.equal(s.snapshot().complete, false);
  const home = await request(s, "/");
  assert.equal(home.status, 200);
  assert.match(home.text, /Continue/);
  assert.equal(s.snapshot().complete, false);
  assert.equal((await request(s, "/done")).status, 200);
  assert.equal(s.snapshot().complete, true);
  assert.equal((await request(s, "/missing")).status, 404);
});

test("localFormOracle: only a valid saved value completes the asynchronous form", { timeout: 5000 }, async (t) => {
  const s = await fixture(t, { tier: "form" });
  assert.equal((await request(s, "/")).status, 200);
  assert.equal((await request(s, "/api/save", { value: "" })).status, 400);
  assert.equal(s.snapshot().complete, false);
  assert.equal((await request(s, "/api/save", { value: "alice" })).status, 200);
  assert.equal(s.snapshot().savedValue, "alice");
  assert.equal(s.snapshot().complete, true);
});

test("localStatefulOracle: session cart and order survive page changes without skipping required actions", { timeout: 5000 }, async (t) => {
  const s = await fixture(t, { tier: "stateful" });
  assert.equal((await request(s, "/api/order", {})).status, 401);
  assert.equal((await request(s, "/login")).status, 200);
  const login = await request(s, "/api/login", { username: "alice" });
  assert.equal(login.status, 200);
  assert.ok(login.cookie);
  assert.equal((await request(s, "/api/order", {}, login.cookie)).status, 409);
  assert.equal((await request(s, "/products", undefined, login.cookie)).status, 200);
  assert.equal((await request(s, "/api/cart", { sku: "book", quantity: 1 }, login.cookie)).status, 200);
  assert.equal((await request(s, "/cart", undefined, login.cookie)).status, 200);
  assert.equal(s.snapshot().cartCount, 1);
  assert.equal(s.snapshot().complete, false);
  assert.equal((await request(s, "/api/order", {}, login.cookie)).status, 200);
  assert.equal((await request(s, "/done", undefined, login.cookie)).status, 200);
  assert.equal(s.snapshot().orderCount, 1);
  assert.equal(s.snapshot().complete, true);
});

test("localVariantsAndIsolation: every v2 changes labels while new instances start with independent state", { timeout: 5000 }, async (t) => {
  for (const [tier, path, before, after] of [["navigation", "/", "Continue", "Proceed"], ["form", "/", "Save", "Store"], ["stateful", "/login", "Log in", "Sign in"]]) {
    const first = await fixture(t, { tier, version: "v1" });
    const second = await fixture(t, { tier, version: "v2" });
    assert.notEqual(first.origin, second.origin);
    assert.match((await request(first, path)).text, new RegExp(before));
    assert.match((await request(second, path)).text, new RegExp(after));
    assert.notEqual(fixtureInfo(tier, "v1").hash, fixtureInfo(tier, "v2").hash);
    assert.deepEqual(first.snapshot(), second.snapshot());
  }
  const first = await fixture(t, { tier: "form" });
  const second = await fixture(t, { tier: "form" });
  await request(first, "/api/save", { value: "alice" });
  assert.equal(first.snapshot().complete, true);
  assert.equal(second.snapshot().complete, false);
  assert.deepEqual(second.requestLog(), []);
  const a = await fixture(t, { tier: "stateful" });
  const b = await fixture(t, { tier: "stateful" });
  const login = await request(a, "/api/login", { username: "alice" });
  await request(a, "/api/cart", { sku: "book", quantity: 1 }, login.cookie);
  assert.equal(a.snapshot().cartCount, 1);
  assert.equal(b.snapshot().cartCount, 0);
  assert.equal(b.snapshot().orderCount, 0);
  assert.deepEqual(b.requestLog(), []);
  assert.equal((await request(b, "/api/order", {}, login.cookie)).status, 401);
  assert.equal(b.snapshot().complete, false);
});

test("localLatencySchedule: route-class delays depend on run index rather than incidental requests", { timeout: 5000 }, async (t) => {
  const latency = { document: [0, 5], api: [0, 40] };
  assert.equal(delayFor(latency, 1, "api"), 40);
  assert.equal(delayFor(latency, 3, "api"), 40);
  assert.equal(delayFor(latency, 2, "document"), 0);
  const s = await fixture(t, { tier: "form", runIndex: 1, latency });
  await request(s, "/favicon.ico");
  await request(s, "/");
  const start = performance.now();
  await request(s, "/api/save", { value: "alice" });
  assert.ok(performance.now() - start >= 30, "the requested 40ms API delay must actually occur");
  const api = s.requestLog().filter((r) => r.path === "/api/save");
  assert.equal(api.length, 1);
  assert.equal(api[0].requestedDelayMs, 40);
  assert.ok(api[0].elapsedMs >= 30);
});

test("localCloseCancelsPendingWork: closing a delayed server settles requests and cannot mutate a new run", { timeout: 3000 }, async (t) => {
  const first = await fixture(t, { tier: "form", latency: { document: [0], api: [10000] } });
  const pending = request(first, "/api/save", { value: "alice" }).catch(() => null);
  for (let i = 0; i < 200 && first.requestLog().length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(first.requestLog().length > 0, "the delayed request was accepted");
  await first.close();
  await pending;
  await first.close();
  assert.equal(first.snapshot().complete, false);
  const second = await fixture(t, { tier: "form" });
  assert.equal(second.snapshot().complete, false);
  assert.deepEqual(second.requestLog(), []);
});

test("localMalformedBodyIsContained: JSON null is a rejected request and does not terminate the fixture process", () => {
  const script = `
    import { startFixture } from ${JSON.stringify(new URL("./local/server.mjs", import.meta.url).href)};
    const fixture = await startFixture({tier:'stateful',version:'v1',runIndex:0,latency:{document:[0],api:[0]}});
    const invalid = await fetch(fixture.origin+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:'null'});
    if (invalid.status !== 400) throw Error('Malformed body was not rejected');
    const valid = await fetch(fixture.origin+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'alice'})});
    if (valid.status !== 200) throw Error('Fixture did not survive invalid input');
    await fixture.close();
  `;
  return import("node:child_process").then(({ spawnSync }) => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 3000 });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stderr);
  });
});

test("localAbortedUploadIsContained: cancelling an accepted partial form upload cannot crash the server", () => {
  const script = `
    import { request } from 'node:http';
    import { startFixture } from ${JSON.stringify(new URL("./local/server.mjs", import.meta.url).href)};
    const fixture = await startFixture({tier:'form',version:'v1',runIndex:0,latency:{document:[0],api:[0]}});
    const upload=request(fixture.origin+'/api/save',{method:'POST',headers:{'content-type':'application/json'}});
    upload.on('error',()=>{});
    upload.write('{"value":"');
    for(let i=0;i<100 && fixture.requestLog().length===0;i++) await new Promise(r=>setTimeout(r,5));
    if(!fixture.requestLog().length) throw Error('Upload was not accepted');
    upload.destroy();
    await new Promise(r=>setTimeout(r,30));
    const valid=await fetch(fixture.origin+'/api/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({value:'alice'})});
    if(valid.status!==200 || !fixture.snapshot().complete) throw Error('Fixture did not survive upload cancellation');
    await fixture.close();
  `;
  return import("node:child_process").then(({ spawnSync }) => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 3000 });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stderr);
  });
});

test("localReservedPortKeepsOneOrigin: sequential runs rebind the port and still start with fresh state", { timeout: 5000 }, async (t) => {
  const port = await reservePort();
  assert.ok(Number.isInteger(port) && port > 1024);
  const first = await startFixture({ tier: "stateful", version: "v1", runIndex: 0, latency: immediate, port });
  t.after(() => first.close());
  assert.equal(new URL(first.origin).port, String(port));
  const login = await freshRequest(first, "/api/login", { username: "alice" });
  assert.equal(login.status, 200);
  assert.equal((await freshRequest(first, "/api/cart", { sku: "book", quantity: 1 }, login.cookie)).status, 200);
  assert.equal(first.snapshot().cartCount, 1);
  await first.close();

  // The frozen URLs of a capture taken above have to match the next run, which is the whole point
  // of reserving the port; the state behind them must not carry over.
  const second = await startFixture({ tier: "stateful", version: "v1", runIndex: 1, latency: immediate, port });
  t.after(() => second.close());
  assert.equal(second.origin, first.origin);
  assert.equal(second.snapshot().cartCount, 0);
  assert.equal(second.snapshot().complete, false);
  assert.equal((await freshRequest(second, "/api/cart", { sku: "book", quantity: 1 }, login.cookie)).status, 401);
});

test("localReservedPortIsFreeAndFailsLoudly: the probe releases the port and a taken port is not shared", { timeout: 5000 }, async (t) => {
  const port = await reservePort();
  const holder = await startFixture({ tier: "navigation", version: "v1", runIndex: 0, latency: immediate, port });
  t.after(() => holder.close());
  await assert.rejects(startFixture({ tier: "navigation", version: "v1", runIndex: 1, latency: immediate, port }), (error) => error.code === "EADDRINUSE");
});
