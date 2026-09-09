// file: bench/local-server.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFixture, delayFor, fixtureInfo } from "./local/server.mjs";

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
