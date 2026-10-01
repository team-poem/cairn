import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "./vercel/order.mjs";
import { GET } from "./vercel/config.mjs";

const order = { product: "field-notebook", quantity: 1, name: "Alex Demo", email: "alex@example.test" };
function request(body, variant = "original") {
  return new Request("https://demo.example/api/order", {
    method: "POST", headers: { "X-Demo-Variant": variant }, body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
test("hosted variants preserve the recorded order contract without sharing state", async () => {
  assert.deepEqual(await GET().json(), { variant: "original" });
  for (const variant of ["original", "changed", "unknown"]) {
    const response = await POST(request(order, variant));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).orderId, "DEMO-1042");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal((await POST(request(order, "broken"))).status, 500);
  assert.equal((await POST(request(order))).status, 200);
});
test("hosted orders reject invalid JSON, oversized bodies, and invalid orders", async () => {
  assert.equal((await POST(request("{"))).status, 400);
  assert.equal((await POST(request("x".repeat(8193)))).status, 413);
  assert.equal((await POST(request({ ...order, quantity: 2 }))).status, 400);
});
