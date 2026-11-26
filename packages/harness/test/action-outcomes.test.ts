import { describe, expect, it } from "vitest";
import { BudgetExceededError, discover, explore, startTrace, type DiscoverOptions, type ExploreOptions, type PageElement, type Target, type TraceEvent } from "../src/index.js";
import { StubDriver } from "./support/doubles.js";
import { stepError } from "../src/core/errors.js";

const baseUrl = "https://fixture.test/start";
const inert = { action: "click", role: "heading", text: "Alpha" };
const link = { action: "click", role: "link", text: "Open Alpha" };
const done = { action: "done" };
const options = { maxRepeats: 2, recoveryTurns: 2 };
type Mode = "discover" | "explore";
type Opts = Partial<DiscoverOptions & ExploreOptions>;

class OutcomeDriver extends StubDriver {
  armed = false;
  beforeClick?: (identity: string | undefined) => void;
  receipt?: string;
  arms = 0;
  snapshots = 0;
  reads = 0;
  identify = (target: Target): string | undefined => `private-node-${target.role}-${target.nth ?? 0}`;
  effect?: (target: Target) => void;
  constructor() {
    super(baseUrl);
    this.els = [{ role: "heading", name: "Alpha" }, { role: "link", name: "Open Alpha" }];
    this.navOn["Open Alpha"] = "https://fixture.test/detail";
  }
  armActionOutcomeIdentity(beforeClick?: (identity: string | undefined) => void) {
    this.arms++; this.armed = true; this.receipt = undefined; this.beforeClick = beforeClick;
  }
  takeActionOutcomeIdentity() {
    this.armed = false;
    this.beforeClick = undefined;
    const result = this.receipt;
    this.receipt = undefined;
    return result;
  }
  override async click(target: Target) {
    const identity = this.armed ? this.identify(target) : undefined;
    this.beforeClick?.(identity);
    await super.click(target);
    if (this.armed) this.receipt = identity;
    this.effect?.(target);
  }
  override async snapshot() {
    const generation = ++this.snapshots;
    return this.els.map((e, i) => ({ ...e, ref: `private-ref-${generation}-${i}` }));
  }
  override async observe() { this.reads++; return super.observe(); }
}

function run(mode: Mode, decide: (turn: number, prompt: string) => object | string, driver = new OutcomeDriver(), extra: Opts = {}) {
  const prompts: string[] = [], events: TraceEvent[] = [];
  const llm = { id: "scripted-outcome", async complete(prompt: string) {
    if (prompt.includes("Propose the verification assertions.")) return "[]";
    prompts.push(prompt);
    const decision = decide(prompts.length, prompt);
    return typeof decision === "string" ? decision : JSON.stringify(decision);
  } };
  const trace = startTrace({ emit: e => { events.push(e); } }, "outcomes").scope("case");
  const result = (mode === "explore" ? explore : discover)("Inspect Alpha", {
    driver, llm, baseUrl, maxSteps: 10, actionOutcomes: options, trace, ...extra,
  });
  return { driver, events, result, prompts };
}

describe.each(["discover", "explore"] as const)("%s action outcome feedback", mode => {
  it("releases the old page's recovery when it navigates before the next input, without crediting that input", async () => {
    const driver = new OutcomeDriver(), statuses: string[] = [];
    delete driver.navOn["Open Alpha"];
    const f = run(mode, turn => {
      if (turn === 1) return inert;
      if (turn === 2) {
        driver.url = baseUrl + "/complete";
        driver.els = [{ role: "link", name: "Open Alpha" }, { role: "heading", name: "Complete" }];
        return link;
      }
      return done;
    }, driver, { actionOutcomes: { maxRepeats: 1, onOutcome: e => statuses.push(e.status) } });
    expect((await f.result).truncated).not.toBe(true);
    expect(driver.clicked).toEqual(["Alpha", "Open Alpha"]);
    expect(statuses).toEqual(["no-observed-change", "insufficient-evidence"]);
  });

  it("counts a unique case-insensitive target while excluding a supplemental host row from explicit scope", async () => {
    const driver = new OutcomeDriver(), statuses: string[] = [];
    const f = run(mode, () => ({ ...inert, text: "alpha" }), driver, {
      perceive: rows => [...rows, { role: "status", name: "Host banner" }],
      actionOutcomes: { maxRepeats: 1, scope: rows => rows.filter(row => row.role === "heading"),
        onOutcome: e => statuses.push(e.status) },
    });
    expect((await f.result).truncationReason).toBe("action-no-progress");
    expect(driver.clicked).toEqual(["alpha"]);
    expect(statuses).toEqual(["no-observed-change"]);
  });

  it("does not block a toggling button by comparing its differently capitalized sibling", async () => {
    const driver = new OutcomeDriver(), statuses: string[] = [];
    driver.els = [{ role: "button", name: "Power", pressed: false }, { role: "button", name: "POWER" },
      { role: "heading", name: "Summary" }];
    driver.effect = () => { driver.els[0]!.pressed = !driver.els[0]!.pressed; };
    const f = run(mode, turn => turn <= 2 ? { action: "click", role: "button", text: "POWER", nth: 0 } : done,
      driver, { actionOutcomes: { maxRepeats: 1, scope: rows => rows.filter(row => row.role === "heading"),
        onOutcome: e => statuses.push(e.status) } });
    expect((await f.result).truncated).not.toBe(true);
    expect(driver.clicked).toEqual(["POWER", "POWER"]);
    expect(statuses).toEqual(["insufficient-evidence", "insufficient-evidence"]);
  });

  it("does not veto the next click when a required input value is unavailable", async () => {
    const driver = new OutcomeDriver(), statuses: string[] = [];
    driver.els = [{ role: "button", name: "Add" }, { role: "textbox", name: "Items" }];
    const f = run(mode, turn => turn <= 2 ? { action: "click", role: "button", text: "Add" } : done, driver, {
      actionOutcomes: { maxRepeats: 1, scope: rows => rows.filter(row => row.role === "textbox"),
        onOutcome: e => statuses.push(e.status) },
    });
    expect((await f.result).truncated).not.toBe(true);
    expect(driver.clicked).toEqual(["Add", "Add"]);
    expect(statuses).toEqual(["insufficient-evidence", "insufficient-evidence"]);
  });

  it("bounds inert clicks across rotating refs and reports incomplete without leaking receipts", async () => {
    const f = run(mode, () => inert);
    const result = await f.result;
    expect(result).toMatchObject({ truncated: true, truncationReason: "action-no-progress" });
    expect(f.driver.clicked).toEqual(["Alpha", "Alpha"]);
    expect(result.steps.filter(s => s.kind === "click")).toHaveLength(2);
    expect(f.prompts[1]).toMatch(/no change was observed/i);
    expect(f.prompts.length).toBeLessThanOrEqual(4);
    expect(JSON.stringify([f.events, f.prompts, result])).not.toMatch(/private-(node|ref)-/);
  });

  it("lets a fresh choice reach a different URL after two unchanged clicks", async () => {
    const f = run(mode, i => i <= 2 ? inert : i === 3 ? link : done);
    expect((await f.result).truncated).not.toBe(true);
    expect(f.driver.clicked).toEqual(["Alpha", "Alpha", "Open Alpha"]);
    expect(f.prompts).toHaveLength(4);
  });

  it("enforces the same click limit on a second inert node without renewing the recovery budget", async () => {
    const driver = new OutcomeDriver();
    delete driver.navOn["Open Alpha"];
    const f = run(mode, turn => turn === 1 ? inert : link, driver, {
      actionOutcomes: { maxRepeats: 1, recoveryTurns: 4 },
    });
    expect(await f.result).toMatchObject({ truncated: true, truncationReason: "action-no-progress" });
    expect(driver.clicked).toEqual(["Alpha", "Open Alpha"]);
    expect(f.prompts.length).toBeLessThanOrEqual(5);
  });

  it("does not credit a request that finished before the recovery click", async () => {
    const driver = new OutcomeDriver(), statuses: string[] = [];
    delete driver.navOn["Open Alpha"];
    let polled = false;
    const observe = driver.observe.bind(driver);
    driver.observe = async () => {
      const evidence = await observe();
      if (polled) evidence.logic.requests.push({ method: "GET", url: baseUrl + "/poll", status: 200 });
      return evidence;
    };
    const locate = driver.locate.bind(driver);
    driver.locate = async target => {
      if (target.text === link.text) polled = true; // after the model replied, but still before input
      return locate(target);
    };
    const f = run(mode, turn => turn === 1 ? inert : turn === 2 ? link : done, driver, {
      actionOutcomes: { maxRepeats: 1, onOutcome: e => statuses.push(e.status) },
    });
    expect(await f.result).toMatchObject({ truncated: true, truncationReason: "action-no-progress" });
    expect(statuses).toEqual(["no-observed-change", "insufficient-evidence"]);
    expect(driver.clicked).toEqual(["Alpha", "Open Alpha"]);
  });

  it("does not compare a decision listing from A to a click result on B", async () => {
    const driver = new OutcomeDriver(), statuses: string[] = [];
    const quantity = (n: number) => ({ role: "spinbutton", name: "Quantity", value: String(n) });
    driver.els.push(quantity(2));
    driver.effect = () => { driver.els[2] = quantity(2); }; // B: 1 -> 2
    const f = run(mode, turn => {
      if (turn !== 1) return done;
      driver.url = baseUrl + "/B";
      driver.els[2] = quantity(1);
      return inert;
    }, driver, { actionOutcomes: { maxRepeats: 1, onOutcome: e => statuses.push(e.status) } });
    expect((await f.result).truncated).not.toBe(true);
    expect(driver.clicked).toHaveLength(1);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).not.toBe("no-observed-change");
  });

  it("uses the host's measured checkbox state without discarding the raw observation", async () => {
    const driver = new OutcomeDriver(), statuses: string[] = [];
    const toggle = { action: "click", role: "checkbox", text: "Gift" };
    driver.els = [{ role: "checkbox", name: "Gift" }];
    let checked = false;
    driver.effect = () => { checked = !checked; };
    const f = run(mode, turn => turn <= 2 ? toggle : done, driver, {
      perceive: rows => rows.map(row => ({ ...row, checked })),
      actionOutcomes: { maxRepeats: 1, onOutcome: e => statuses.push(e.status) },
    });
    expect((await f.result).truncated).not.toBe(true);
    expect(driver.clicked).toEqual(["Gift", "Gift"]);
    expect(statuses).toEqual(["observed-change", "observed-change"]);
  });

  it("does not clear repetition just because a previously measured fact became unavailable", async () => {
    const driver = new OutcomeDriver();
    driver.els[0]!.occluded = false;
    const f = run(mode, turn => {
      if (turn === 1) return inert;
      if (turn === 2) { delete driver.els[0]!.occluded; return "invalid JSON"; }
      return done;
    }, driver, { actionOutcomes: { maxRepeats: 1, recoveryTurns: 2 } });
    expect(await f.result).toMatchObject({ truncated: true, truncationReason: "action-no-progress" });
    expect(driver.clicked).toEqual(["Alpha"]);
  });

  it("does not enforce repetition when the driver located a control absent from the snapshot", async () => {
    const driver = new OutcomeDriver(), statuses: string[] = [];
    driver.els = [{ role: "heading", name: "Cart" }];
    const increment = { action: "click", role: "button", text: "Increment" };
    const f = run(mode, turn => turn <= 2 ? increment : done, driver, {
      actionOutcomes: { maxRepeats: 1, onOutcome: e => statuses.push(e.status) },
    });
    expect((await f.result).truncated).not.toBe(true);
    expect(driver.clicked).toEqual(["Increment", "Increment"]);
    expect(statuses).toEqual(["insufficient-evidence", "insufficient-evidence"]);
  });

  it("rechecks the original control when a recovery click lands, without crediting that click", async () => {
    const driver = new OutcomeDriver(), statuses: string[] = [];
    driver.els = [{ role: "checkbox", name: "A", checked: false }, { role: "button", name: "B" },
      { role: "heading", name: "Summary" }];
    driver.effect = t => { if (t.text === "B") driver.els[0]!.checked = true; };
    const f = run(mode, turn => turn > 2 ? done : { action: "click", role: turn === 1 ? "checkbox" : "button",
      text: turn === 1 ? "A" : "B" }, driver, { actionOutcomes: { maxRepeats: 1,
      scope: rows => rows.filter(e => e.role === "heading"), onOutcome: e => statuses.push(e.status) } });
    expect((await f.result).truncated).not.toBe(true);
    expect(driver.clicked).toEqual(["A", "B"]);
    expect(statuses).toEqual(["no-observed-change", "no-observed-change"]);
  });

  it("keeps positive evidence from a declared row even when the clicked control disappears", async () => {
    const driver = new OutcomeDriver(), statuses: string[] = [];
    driver.els = [{ role: "button", name: "Show details" }, { role: "status", name: "Details", value: "closed" }];
    driver.effect = () => { driver.els = [{ role: "status", name: "Details", value: "open" }]; };
    const f = run(mode, turn => turn === 1 ? { action: "click", role: "button", text: "Show details" } : done, driver,
      { actionOutcomes: { maxRepeats: 1, scope: rows => rows.filter(e => e.name === "Details"),
        onOutcome: e => statuses.push(e.status) } });
    await f.result;
    expect(statuses).toEqual(["observed-change"]);
  });

  it("reconciles a delayed change at the step cap even without a host stop hook", async () => {
    const driver = new OutcomeDriver();
    const f = run(mode, turn => {
      if (turn === 1) return inert;
      driver.els.push({ role: "status", name: "Saved" });
      return "invalid JSON";
    }, driver, { maxSteps: 2, actionOutcomes: { maxRepeats: 1 } });
    const result = await f.result;
    expect(result.truncated).toBe(true); // the ordinary step cap, not a verified goal
    expect(result.truncationReason).toBeUndefined();
    expect(driver.clicked).toEqual(["Alpha"]);
    expect(f.prompts).toHaveLength(2);
  });

  it("recognizes a delayed state change on the next observation after a veto, without inventing another execution", async () => {
    const driver = new OutcomeDriver(), observed: string[] = [];
    const f = run(mode, turn => {
      if (turn === 3) driver.els.push({ role: "status", name: "Details ready" });
      return turn <= 3 ? inert : done;
    }, driver, { actionOutcomes: { ...options, onOutcome: e => { observed.push(e.status); } } });
    const result = await f.result;
    expect(result.truncated).not.toBe(true);
    expect(f.prompts).toHaveLength(4);
    expect(f.prompts[3]).toContain("Details ready");
    expect(driver.clicked).toEqual(["Alpha", "Alpha"]);
    expect(observed).toEqual(["no-observed-change", "no-observed-change"]);
  });

  it.each(["done", "parse", "policy"] as const)("does not treat %s as recovery", async status => {
    const f = run(mode, i => i <= 2 ? inert : status === "done" ? done : status === "parse" ? "invalid JSON" : link,
      new OutcomeDriver(), { policy: { vet: d => d.text === link.text ? { ok: false, reason: "not allowed" } : { ok: true } } });
    expect(await f.result).toMatchObject({ truncated: true, truncationReason: "action-no-progress" });
    expect(f.driver.clicked).toEqual(["Alpha", "Alpha"]);
    expect(f.prompts.length).toBeLessThanOrEqual(4);
  });

  it("permits a trusted goal on the fresh observation, including at the step cap", async () => {
    const driver = new OutcomeDriver();
    const f = run(mode, () => inert, driver, { maxSteps: 2, policy: {
      vet: () => ({ ok: true }), stop: () => driver.clicked.length === 2,
    } });
    expect((await f.result).truncated).not.toBe(true);
  });

  it("uses the final observed URL for a trusted goal reached by the last allowed step", async () => {
    const f = run(mode, () => link, new OutcomeDriver(), {
      maxSteps: 1, policy: { vet: () => ({ ok: true }), stop: (_steps, ctx) => ctx?.url === "https://fixture.test/detail" },
    });
    expect((await f.result).truncated).not.toBe(true);
    expect(f.driver.clicked).toEqual(["Open Alpha"]);
  });

  it("charges recovery decisions to the original model budget", async () => {
    const f = run(mode, i => i <= 2 ? inert : link, new OutcomeDriver(), { budget: { maxModelCalls: 2 } });
    await expect(f.result).rejects.toBeInstanceOf(BudgetExceededError);
    expect(f.prompts).toHaveLength(2);
    expect(f.driver.clicked).toEqual(["Alpha", "Alpha"]);
  });

  it("never dispatches a recovery choice once the host cancels", async () => {
    const controller = new AbortController();
    const f = run(mode, i => {
      if (i < 3) return inert;
      controller.abort(new Error("host stopped recovery"));
      return link;
    }, new OutcomeDriver(), { signal: controller.signal });
    await expect(f.result).rejects.toThrow("host stopped recovery");
    expect(f.driver.clicked).toEqual(["Alpha", "Alpha"]);
  });

  it("does not ask again after losing the driver connection during recovery lookup", async () => {
    const driver = new OutcomeDriver();
    const locate = driver.locate.bind(driver);
    const disconnected = stepError("transport", "connection lost during lookup");
    driver.locate = async t => {
      if (t.text === link.text) throw disconnected;
      return locate(t);
    };
    const f = run(mode, i => i === 1 ? inert : i === 2 ? link : done, driver, {
      actionOutcomes: { maxRepeats: 1 },
    });
    await expect(f.result).rejects.toBe(disconnected);
    expect(f.prompts).toHaveLength(2);
    expect(driver.clicked).toEqual(["Alpha"]);
  });

  it("does not combine acknowledged clicks on different nodes with the same name and role", async () => {
    const driver = new OutcomeDriver();
    driver.els.push({ role: "heading", name: "Alpha" });
    const f = run(mode, i => i <= 2 ? { ...inert, nth: i - 1 } : done, driver);
    expect((await f.result).truncated).not.toBe(true);
    expect(driver.clicked).toHaveLength(2);
  });

  it("a lost click acknowledgement neither retries nor attaches the new page to an earlier step", async () => {
    const driver = new OutcomeDriver();
    driver.effect = t => { if (t.role === "link") throw new Error("click acknowledgement lost"); };
    const observed: unknown[] = [];
    const f = run(mode, i => i === 1 ? inert : link, driver, { actionOutcomes: {
      ...options, onOutcome: outcome => { observed.push(outcome); },
    } });
    const result = await f.result;
    expect(driver.clicked).toEqual(["Alpha", "Open Alpha"]);
    expect(f.prompts).toHaveLength(2);
    expect(result).toMatchObject({ truncated: true, truncationReason: "click-dispatch-uncertain" });
    expect(result.steps.filter(s => s.kind === "click")).toEqual([{ kind: "click", target: { role: "heading", text: "Alpha" } }]);
    expect(observed).toEqual([{ stepIndex: 1, action: "click", status: "no-observed-change" }]);
  });

  it("does not count a same-named replacement whose dispatch receipt identifies a new node", async () => {
    const driver = new OutcomeDriver();
    driver.identify = () => `private-node-generation-${driver.clicked.length}`;
    const f = run(mode, i => i <= 4 ? inert : done, driver);
    expect((await f.result).truncated).not.toBe(true);
    expect(driver.clicked).toHaveLength(4);
  });

  it("does not resubmit an unacknowledged Enter during recovery", async () => {
    const driver = new OutcomeDriver();
    let submissions = 0;
    driver.pressKey = async () => { submissions++; throw new Error("reply lost"); };
    const f = run(mode, i => i <= 2 ? inert : { action: "pressKey", key: "Enter" }, driver);
    const result = await f.result;
    expect(result.truncationReason).toBe("action-dispatch-uncertain");
    expect(result.steps.some(s => s.kind === "pressKey")).toBe(false);
    expect(submissions).toBe(1);
    expect(f.prompts).toHaveLength(3);
  });

  it("can exclude a rotating banner only when the host declares the relevant rows", async () => {
    const driver = new OutcomeDriver();
    driver.els.push({ role: "status", name: "Promotion 0" });
    driver.effect = () => { driver.els[2] = { role: "status", name: `Promotion ${driver.clicked.length}` }; };
    const f = run(mode, () => inert, driver, { actionOutcomes: { ...options,
      scope: (rows: readonly PageElement[]) => rows.filter(e => e.role !== "status"),
    } });
    expect((await f.result).truncationReason).toBe("action-no-progress");
    expect(driver.clicked).toHaveLength(2);
  });

  it("observes a quantity change even when its row does not reach the decision prompt", async () => {
    const driver = new OutcomeDriver();
    driver.els.push(...Array.from({ length: 65 }, (_, i) => ({ role: "button", name: `Action ${i}` })));
    driver.els.push({ role: "StaticText", name: "Quantity 0" });
    driver.effect = () => { driver.els[driver.els.length - 1] = { role: "StaticText", name: `Quantity ${driver.clicked.length}` }; };
    const f = run(mode, i => i <= 4 ? inert : done, driver);
    expect((await f.result).truncated).not.toBe(true);
    expect(driver.clicked).toHaveLength(4);
    expect(f.prompts[1]).not.toContain("Quantity 1");
    expect(f.prompts[1]).not.toMatch(/no change was observed/i);
  });

  it.each(["identity", "scope"] as const)("abstains without sufficient %s", async missing => {
    const driver = new OutcomeDriver();
    if (missing === "identity") driver.identify = () => undefined;
    const f = run(mode, i => i <= 4 ? inert : done, driver, { actionOutcomes: {
      ...options, ...(missing === "scope" ? { scope: () => [] } : {}),
    } });
    expect((await f.result).truncated).not.toBe(true);
    expect(driver.clicked).toHaveLength(4);
    if (missing === "scope") expect(f.prompts[1]).toMatch(/insufficient evidence/i);
  });

  it("isolates concurrent invocations sharing the same configuration", async () => {
    const a = run(mode, () => inert);
    const b = run(mode, i => i === 1 ? inert : done);
    const [repeated, single] = await Promise.all([a.result, b.result]);
    expect(repeated.truncationReason).toBe("action-no-progress");
    expect(single.truncated).not.toBe(true);
    expect(a.driver.clicked).toHaveLength(2);
    expect(b.driver.clicked).toHaveLength(1);
  });

  it("does not arm identity measurement or change the frozen click count without the policy", async () => {
    const f = run(mode, i => i <= 4 ? inert : done, new OutcomeDriver(), { actionOutcomes: undefined });
    const result = await f.result;
    expect(result.truncated).not.toBe(true);
    expect(result.steps.filter(s => s.kind === "click")).toHaveLength(4);
    expect(f.driver.arms).toBe(0);
  });
});

it("does not report a dead action when passive explore sees a host-measured change", async () => {
  const driver = new OutcomeDriver();
  driver.els = [{ role: "checkbox", name: "Gift" }];
  let checked = false;
  driver.effect = () => { checked = true; };
  const f = run("explore", i => i === 1 ? { action: "click", role: "checkbox", text: "Gift" } : done,
    driver, { actionOutcomes: undefined, perceive: rows => rows.map(row => ({ ...row, checked })) });
  const result = await f.result;
  if (!("findings" in result)) throw new Error("expected an exploration report");
  expect(result.findings.filter(finding => finding.kind === "dead-action")).toEqual([]);
  expect(f.prompts[1]).toMatch(/observed change|change was observed/i);
  expect(driver.clicked).toEqual(["Gift"]);
  expect(driver.arms).toBe(0);
});
