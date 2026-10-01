import { afterEach, expect, it, vi } from "vitest";
import { AssertionCritic, toVerdict } from "../src/adapters/critics/assertion.js";
import { FakeDriver } from "../src/adapters/drivers/fake.js";
import { ConsoleReporter } from "../src/adapters/reporters/console.js";
import { finalizeVerdict, goalFailures } from "../src/core/pipeline.js";
import { assertionPayload } from "../src/core/trace.js";
import { runScenario } from "../src/run.js";
import type { Assertion, Evidence } from "../src/core/types.js";

const evidence: Evidence = {
  execution: { actions: [], navigated: true, finalUrl: "https://app/done", blocked: false },
  perception: {}, logic: { requests: [], console: [] },
};
const optional: Assertion = { kind: "custom", name: "session" };
const arrival: Assertion = { kind: "navigated", to: "https://app/done" };
const custom = { session: async () => ({ inconclusive: true as const, detail: "Session request was not observed" }) };
afterEach(() => vi.restoreAllMocks());

it("excludes unobserved custom evidence from a mixed green's proof and preserves trace detail", async () => {
  const judged = await new AssertionCritic(custom).judge(evidence, [optional, arrival]);
  const verdict = finalizeVerdict(judged);
  expect(verdict.passed).toBe(true);
  expect(verdict.proof).toMatchObject({ grade: "arrival", work: 0, discriminating: 1 });
  expect(judged.results[0]).toMatchObject({ passed: false, reason: "inconclusive" });
  expect(assertionPayload(judged.results[0]!)).toMatchObject({ reason: "inconclusive", detail: "Session request was not observed" });
  expect(goalFailures(verdict)).toEqual([]);
});

it("fails closed when nothing can be judged, including beside a vacuous check", async () => {
  const critic = new AssertionCritic(custom);
  const all = finalizeVerdict(await critic.judge(evidence, [optional]));
  expect(all).toMatchObject({ passed: false, failClosed: "all-inconclusive", failure: "script" });
  expect(all.proof).toBeUndefined();
  expect(await critic.judge(evidence, [optional, { ...arrival, vacuous: true }]))
    .toMatchObject({ passed: false, failClosed: "all-vacuous" });
  expect(toVerdict([]).failClosed).toBe("no-assertions");
});

it("preserves real flow and judge failures next to an inconclusive result", async () => {
  const critic = new AssertionCritic(custom);
  expect(finalizeVerdict(await critic.judge(evidence, [optional, { kind: "navigated", to: "https://app/missing" }])).failure).toBe("flow");
  expect(finalizeVerdict(await critic.judge(evidence, [optional, { kind: "custom", name: "missing" }])).failure).toBe("environment");
});

it("does not spend model calls healing absent evidence and reports it neutrally", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const complete = vi.fn(async () => { throw new Error("No healing expected"); });
  const { result, healedScenario } = await runScenario({ name: "session", steps: [], assertions: [optional] }, {
    driver: new FakeDriver({ evidence }), custom, heal: true,
    llm: { id: "unused", complete }, reporter: new ConsoleReporter(),
  });
  expect(complete).not.toHaveBeenCalled();
  expect(healedScenario).toBeUndefined();
  expect(result.verdict.passed).toBe(false);
  const output = log.mock.calls.flat().join("\n");
  expect(output).toContain("· inconclusive custom");
  expect(output).not.toContain("✗ custom");
});

it("withholds a re-discovered path when its original custom goal becomes inconclusive", async () => {
  let checks = 0;
  const complete = vi.fn(async () => JSON.stringify({ action: "done" }));
  const { healedScenario, result } = await runScenario({ name: "session", steps: [], assertions: [optional, arrival] }, {
    driver: new FakeDriver({ evidence }), heal: true,
    custom: { session: () => ++checks === 1 ? false : { inconclusive: true, detail: "No session evidence" } },
    llm: { id: "scripted", complete }, reporter: { emit: async () => {} },
  });
  expect(checks).toBeGreaterThan(1);
  expect(result.verdict.results).toContainEqual(expect.objectContaining({ reason: "inconclusive" }));
  expect(healedScenario).toBeUndefined();
});
