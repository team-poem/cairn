import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { startServer } from "./server.mjs";

const order = {
  product: "field-notebook",
  quantity: 1,
  name: "Alex Demo",
  email: "alex@example.test",
};

test("recorded JSON is served as its original document, not a serialized Buffer", async () => {
  const artifacts = await mkdtemp(resolve(tmpdir(), "cairn-demo-json-"));
  const documents = {
    "manifest.json": { complete: true, stages: [{ id: "discover", status: "recorded" }] },
    "scenario.json": { steps: [], assertions: [] },
    "trace.json": [{ kind: "action", phase: "discover" }],
  };
  const server = await startServer({ port: 0, artifacts });
  try {
    for (const [name, document] of Object.entries(documents)) {
      const bytes = JSON.stringify(document, null, 2) + "\n";
      await writeFile(resolve(artifacts, name), bytes);
      const response = await fetch(server.origin + "/recording/" + name);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "application/json");
      assert.equal(await response.text(), bytes);
    }
  } finally {
    await server.close();
    await rm(artifacts, { recursive: true, force: true });
  }
});

test("a UI-only change preserves the order contract; an application defect does not", async () => {
  for (const variant of ["original", "changed", "broken"]) {
    const server = await startServer({ port: 0, variant });
    try {
      const config = await fetch(server.origin + "/api/config").then((r) =>
        r.json(),
      );
      assert.equal(config.variant, variant);
      const response = await fetch(server.origin + "/api/order", {
        method: "POST",
        body: JSON.stringify(order),
      });
      assert.equal(response.status, variant === "broken" ? 500 : 200);
      assert.equal(server.snapshot().completed, variant !== "broken");
      assert.equal(
        (await fetch(server.origin + "/shop/complete")).status,
        200,
        "Arrival remains possible even when the API fails",
      );
      assert.equal(server.snapshot().orders.length, 1);
    } finally {
      await server.close();
    }
  }
});

test("invalid orders cannot satisfy the success oracle and a fresh run has no previous orders", async () => {
  for (let run = 0; run < 2; run++) {
    const server = await startServer({ port: 0 });
    try {
      assert.equal(server.snapshot().orders.length, 0);
      for (const body of [
        "not JSON",
        JSON.stringify({ ...order, quantity: 0 }),
        JSON.stringify({ ...order, email: "invalid" }),
        JSON.stringify({ ...order, name: {} }),
      ]) {
        assert.equal(
          (await fetch(server.origin + "/api/order", { method: "POST", body }))
            .status,
          400,
        );
      }
      assert.equal(server.snapshot().completed, false);
      assert.equal(
        (
          await fetch(server.origin + "/api/order", {
            method: "POST",
            body: JSON.stringify(order),
          })
        ).status,
        200,
      );
      assert.equal(server.snapshot().completed, true);
    } finally {
      await server.close();
    }
  }
});

test("the viewer serves real artifacts separately and does not expose the repository", async () => {
  const server = await startServer({
    port: 0,
    artifacts: "/private/tmp/cairn-does-not-exist",
  });
  try {
    const page = await fetch(server.origin + "/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /RECORDED EXECUTION/);
    assert.equal(
      (await fetch(server.origin + "/recording/manifest.json")).status,
      404,
    );
    assert.equal(
      (await fetch(server.origin + "/%2e%2e%2fserver.mjs")).status,
      403,
    );
    assert.equal((await fetch(server.origin + "/package.json")).status, 404);
    assert.equal(
      (await fetch(server.origin + "/api/order", { method: "DELETE" })).status,
      405,
    );
    assert.equal(
      (
        await fetch(server.origin + "/api/order", {
          method: "POST",
          body: "x".repeat(9000),
        })
      ).status,
      413,
    );
  } finally {
    await server.close();
  }
});
