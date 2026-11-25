import { expect, it } from "vitest";
import { AssertionCritic, identifyScenario, InlineContextProvider, prepareReplayCleanup, runHarness, StaticPlanner,
  type Scenario, type Step } from "../src/index.js";
import { applyReplayCleanup, recordReplayCleanup } from "../src/core/replay-cleanup.js";
import { StubDriver } from "./support/doubles.js";

async function fixture() {
  const params = { target: { id: "B" } };
  const target = { role: "button", text: "Show summary" };
  const click: Step = { kind: "click", target };
  const judgment = { judgmentKey: "host-registry-v1", opaque: false };
  const scenario: Scenario = await identifyScenario({
    name: "Review B", steps: [{ kind: "custom", name: "open", params }, click, click],
    assertions: [{ kind: "custom", name: "reviewed", params }],
  }, { intent: "Review B", ...judgment });
  const declaration = { revision: "1", scope: "review", semantics: "idempotent-click" as const, target, repeatIndex: 2 };
  const approval = await prepareReplayCleanup(scenario, await recordReplayCleanup(scenario), declaration);
  if (approval.status !== "approved") throw new Error(approval.reason);
  return { scenario, params, judgment, options: { approval, declaration } };
}

it("passes the same params to registered actions and checks on the original and approved paths", async () => {
  const { scenario, params, judgment, options } = await fixture();
  // A host can build this registry from a loaded skill. Comparing JSON does not establish membership.
  const registry = new Map<object, string>([[params, "B"]]);
  for (const enabled of [false, true]) {
    const driver = new StubDriver();
    let opened: string | undefined;
    const result = await runHarness({ driver, context: new InlineContextProvider(), planner: new StaticPlanner(scenario),
      critic: new AssertionCritic({ reviewed: p => opened === "B" && registry.get(p) === opened }),
      reporter: { async emit() {} } }, scenario.name, { judgment, actions: { open: async (_driver, p) => { opened = registry.get(p); } },
      ...(enabled && { replayCleanup: options }) });
    expect(result.verdict.passed).toBe(true);
    expect(driver.clicked).toHaveLength(enabled ? 1 : 2);
  }
});

it.each(["root reference", "nested reference", "value", "new getter"] as const)(
  "keeps the original path when custom params change during approval: %s", async change => {
    const { scenario, params, options } = await fixture();
    const deciding = applyReplayCleanup(scenario, options);
    let reads = 0;
    if (change === "root reference" && scenario.assertions[0]?.kind === "custom") scenario.assertions[0].params = { ...params };
    if (change === "nested reference") params.target = { ...params.target };
    if (change === "value") params.target.id = "C";
    if (change === "new getter") Object.defineProperty(params.target, "id", { get() { reads++; return "B"; } });
    expect(await deciding).toBe(scenario);
    expect(reads).toBe(0);
  },
);

it("marks the judgment identity incomplete if the custom check mutates its original params during replay", async () => {
  const { scenario, params, judgment, options } = await fixture();
  const result = await runHarness({ driver: new StubDriver(), context: new InlineContextProvider(), planner: new StaticPlanner(scenario),
    critic: new AssertionCritic({ reviewed: () => { params.target.id = "C"; return false; } }),
    reporter: { async emit() {} } }, scenario.name, { judgment, actions: { async open() {} }, replayCleanup: options });
  expect(result.replayCleanup?.status).toBe("approved");
  expect(result.verdict.passed).toBe(false);
  expect(result.verdict.contract?.complete).toBe(false);
});
