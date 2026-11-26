import { expect, it, vi } from "vitest";
import {
  AssertionCritic, compareContracts, identifyScenario, InlineContextProvider, prepareReplayCleanup,
  runHarness, runScenario, StaticPlanner, type Assertion, type JudgmentOptions, type RunScenarioOptions,
} from "../src/index.js";
import { recordReplayCleanup } from "../src/core/replay-cleanup.js";
import { StubDriver } from "./support/doubles.js";

const intent = "Show the panel";
const target = { role: "button", text: "Show" };
const reporter = { async emit() {} };
const forbidden = vi.fn(async (): Promise<never> => { throw new Error("unrequested model call"); });

async function fixture(assertions: Assertion[] = [{ kind: "navigated", to: "/panel" }], judgment: JudgmentOptions = {}) {
  const scenario = await identifyScenario({ name: intent, steps: [
    { kind: "goto", url: "https://app.test/panel" }, { kind: "click", target }, { kind: "click", target },
  ], assertions }, { intent, ...judgment });
  const declaration = { scope: "panel", revision: "v1", semantics: "idempotent-click" as const, target, repeatIndex: 2 };
  const approval = await prepareReplayCleanup(scenario, await recordReplayCleanup(scenario), declaration);
  if (approval.status !== "approved") throw new Error(approval.reason);
  return { scenario, replayCleanup: { approval, declaration } };
}

class ConsoleFailure extends StubDriver {
  override async observe() {
    const evidence = await super.observe();
    evidence.logic.console.push({ type: "error", text: "panel failed" });
    return evidence;
  }
}

it("runScenario judges the shortened replay with the rules that authorized it", async () => {
  const { scenario, replayCleanup } = await fixture([{ kind: "no-console-errors" }]);
  const driver = new ConsoleFailure(), benignConsole: string[] = [];
  const { result } = await runScenario(scenario, { driver, reporter, benignConsole, replayCleanup,
    onStep() { benignConsole.push("panel failed"); } });
  expect(driver.clicked).toEqual(["Show"]);
  expect(result.replayCleanup?.status).toBe("approved");
  expect(result.verdict.passed).toBe(false);
  expect(compareContracts(scenario.contract, result.verdict.contract)).toBe("same");
});

it("runScenario captures the registered custom check before dispatch", async () => {
  const judgmentKey = "panel-check-v1";
  const { scenario, replayCleanup } = await fixture([{ kind: "custom", name: "panel" }], { judgmentKey });
  const driver = new StubDriver(), custom: { panel: () => boolean } = Object.create({ panel: () => false });
  const { result } = await runScenario(scenario, { driver, reporter, judgmentKey, custom, replayCleanup,
    onStep() { custom.panel = () => true; } });
  expect(driver.clicked).toEqual(["Show"]);
  expect(result.verdict.passed).toBe(false);
  expect(compareContracts(scenario.contract, result.verdict.contract)).toBe("same");
});

it("runHarness does not attest unchanged settings for an injected critic that read a changed console filter", async () => {
  const benignConsole: string[] = [], judgment = { opaque: false, benignConsole };
  const { scenario, replayCleanup } = await fixture([{ kind: "no-console-errors" }], judgment);
  const driver = new ConsoleFailure();
  const result = await runHarness({ driver, context: new InlineContextProvider(), planner: new StaticPlanner(scenario),
    critic: new AssertionCritic({}, [], benignConsole), reporter }, intent, { judgment, replayCleanup,
    onStep() { benignConsole.push("panel failed"); } });
  expect(driver.clicked).toEqual(["Show"]);
  expect(result.verdict.passed).toBe(true); // This critic read the host's new filter.
  expect(compareContracts(scenario.contract, result.verdict.contract)).toBe("unknown");
});

it("keeps the full path if the injected critic changes its declared rules before planning finishes", async () => {
  const benignConsole: string[] = [], judgment = { opaque: false, benignConsole };
  const { scenario, replayCleanup } = await fixture([{ kind: "no-console-errors" }], judgment);
  const driver = new ConsoleFailure();
  const result = await runHarness({ driver, context: new InlineContextProvider(),
    planner: { async plan() { benignConsole.push("panel failed"); return scenario; } },
    critic: new AssertionCritic({}, [], benignConsole), reporter }, intent, { judgment, replayCleanup });
  expect(driver.clicked).toEqual(["Show", "Show"]);
  expect(result.replayCleanup).toEqual({ status: "declined", reason: "stale-approval" });
  expect(compareContracts(scenario.contract, result.verdict.contract)).toBe("changed");
});

const environment = { baseUrl: "https://staging.test", allowedHosts: ["app.test"] };
const targetChoice = { selector: { select: forbidden }, minConfidence: null };
it.each<[string, RunScenarioOptions, string]>([
  ["environment reanchoring", { replayEnvironment: environment }, "https://staging.test/panel"],
  ["healing", { heal: true }, "https://app.test/panel"],
  ["target choice", { targetChoice }, "https://app.test/panel"],
])("declines only cleanup when the caller requests %s", async (_name, mode, expectedUrl) => {
  const { scenario, replayCleanup } = await fixture();
  const driver = new StubDriver(), onDecision = vi.fn(), emit = vi.fn();
  const { result } = await runScenario(scenario, { ...mode, driver, reporter: { emit }, llm: { id: "forbidden", complete: forbidden },
    replayCleanup: { ...replayCleanup, onDecision } });
  expect(result.verdict.passed).toBe(true);
  expect(driver.url).toBe(expectedUrl);
  expect(driver.clicked).toEqual(["Show", "Show"]);
  expect(forbidden).not.toHaveBeenCalled();
  expect(result.replayCleanup).toEqual({ status: "declined", reason: "unsupported-replay" });
  expect(emit.mock.calls).toEqual([[result]]);
  expect(onDecision.mock.calls).toEqual([[result.replayCleanup]]);
});

it("retains replay entry validation and cancellation before a second dispatch", async () => {
  const { scenario, replayCleanup } = await fixture();
  const driver = new StubDriver(), onDecision = vi.fn(), control = new AbortController();
  const options = { driver, reporter, replayCleanup: { ...replayCleanup, onDecision } };
  await expect(runScenario(scenario, { ...options, replayEnvironment: { ...environment, allowedHosts: ["elsewhere.test"] } }))
    .rejects.toThrow("entry goto");
  expect(driver.clicked).toEqual([]);
  await expect(runScenario(scenario, { ...options, heal: true, signal: control.signal,
    onStep({ step }) { if (step.kind === "click") control.abort(new Error("stop after one")); } })).rejects.toThrow("stop after one");
  expect(driver.clicked).toEqual(["Show"]);
  expect(onDecision).not.toHaveBeenCalled();
});

it("keeps the reporter before outcome healing when only cleanup was declined", async () => {
  const { scenario, replayCleanup } = await fixture([{ kind: "navigated", to: "/never-reached" }]);
  for (const cleanup of [undefined, replayCleanup]) {
    const driver = new StubDriver(), complete = vi.fn(async () => '{"action":"done"}');
    const emit = vi.fn(async () => { throw new Error("reporter stopped the run"); });
    await expect(runScenario(scenario, { driver, reporter: { emit }, heal: true, llm: { id: "unused", complete },
      replayCleanup: cleanup })).rejects.toThrow("reporter stopped the run");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    expect(driver.clicked).toEqual(["Show", "Show"]);
  }
});
