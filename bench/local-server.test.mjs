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
