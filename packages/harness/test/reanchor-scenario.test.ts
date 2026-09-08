// file: packages/harness/test/reanchor-scenario.test.ts
import { expect, test } from "vitest";
import type { Scenario } from "../src/core/types.js";
import { reanchorScenario } from "../src/core/replay-environment.js";
const env = { baseUrl: "http://localhost:3000/", allowedHosts: ["stage.test", "stage.test:8443"] };

test("reanchorScenarioPure: only declared URL fields and exact hosts are transformed", () => {
  const target = { text: "https://stage.test/label" };
  const requestStatus = { urlIncludes: "stage.test/api?op=Save", status: 200 };
  const customParams = { url: "https://stage.test/data" };
  const s: Scenario = { name: "mapping", wildcards: true, steps: [
    { kind: "goto", url: "https://stage.test/?a=1#h" },
    { kind: "goto", url: "https://stage.test:8443/cart?q=1#x" },
    { kind: "goto", url: "https://stage.test:8444/cart" },
    { kind: "click", target, expect: { url: "stage.test/en/orders/*?a=1#h", requestStatus } },
    { kind: "waitFor", until: { url: "https://stage.test/en/cart", requestStatus, text: "stage.test/cart" } },
    { kind: "custom", name: "visit", params: customParams },
  ], assertions: [
    { kind: "navigated", to: "stage.test/en/orders/*?a=1#h", origin: "user" },
    { kind: "navigated", to: "stage.test" }, { kind: "navigated", to: "/cart" },
    { kind: "navigated", to: "https://stage.test" }, { kind: "navigated", to: "evil.stage.test/cart" },
    { kind: "request-status", ...requestStatus }, { kind: "custom", name: "check", params: customParams },
    { kind: "expect", criterion: "https://stage.test/cart remains literal prose" },
  ] };
  const before = JSON.stringify(s); const mapped = reanchorScenario(s, env);
  expect(mapped.steps[0]).toEqual({ kind: "goto", url: "http://localhost:3000/?a=1#h" });
  expect(mapped.steps[1]).toEqual({ kind: "goto", url: "http://localhost:3000/cart?q=1#x" });
  expect(mapped.steps[2]).toBe(s.steps[2]);
  expect(mapped.steps[3]).toEqual({ kind: "click", target, expect: { url: "localhost:3000/en/orders/*?a=1#h", requestStatus } });
  const click = mapped.steps[3]; expect(click && "target" in click && click.target).toBe(target);
  expect(mapped.steps[4]).toEqual({ kind: "waitFor", until: { url: "http://localhost:3000/en/cart", requestStatus, text: "stage.test/cart" } });
  expect(mapped.steps[5]).toBe(s.steps[5]);
  expect(mapped.assertions[0]).toEqual({ ...s.assertions[0], to: "localhost:3000/en/orders/*?a=1#h" });
  expect(mapped.assertions[1]).toEqual({ ...s.assertions[1], to: "localhost:3000" });
  expect(mapped.assertions[3]).toEqual({ ...s.assertions[3], to: "http://localhost:3000" });
  expect([mapped.assertions[2], ...mapped.assertions.slice(4)]).toEqual([s.assertions[2], ...s.assertions.slice(4)]);
  expect(reanchorScenario(mapped, env)).toEqual(mapped); expect(JSON.stringify(s)).toBe(before);
  const root = reanchorScenario({ ...s, steps: [{ kind: "goto", url: "https://stage.test" }] }, env);
  expect(root.steps).toEqual([{ kind: "goto", url: "http://localhost:3000/" }]);
});
