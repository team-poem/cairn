import { describe, expect, it } from "vitest";
import { discover, explore, startTrace, type TraceEvent } from "../src/index.js";
import { stepError } from "../src/core/errors.js";
import type { ConsoleMessage, NetworkRequest, Target } from "../src/core/types.js";
import { StubDriver } from "./support/doubles.js";

const baseUrl = "https://fixture.test/cart", receipt = "https://fixture.test/receipt";
const click = (text: string) => ({ action: "click", role: "button", text });
const done = { action: "done" };

class Fixture extends StubDriver {
  requests: NetworkRequest[] = [];
  messages: ConsoleMessage[] = [];
  constructor() {
    super(baseUrl);
    this.els = ["A", "B", "C"].map(name => ({ role: "button", name }));
  }
  override async observe() {
    const evidence = await super.observe();
    return { ...evidence, logic: { ...evidence.logic, requests: this.requests.slice(), console: this.messages.slice() } };
  }
}

function script(...decisions: object[]) {
  let turn = 0;
  return { id: "lifecycle", async complete(prompt: string) {
    if (prompt.includes("Propose the verification assertions.")) return "[]";
    return JSON.stringify(decisions[turn++] ?? done);
  } };
}

describe.each([["discover", discover], ["explore", explore]] as const)("%s dispatch and observation boundaries", (_name, run) => {
  it("discards a decision if the URL changes after approval; the policy sees each new decision once", async () => {
    const driver = new Fixture(), vetted: (string | undefined)[] = [];
    driver.locate = async target => { if (target.text === "A") driver.url = receipt; return target; };
    const result = await run("try once on each page", { driver, baseUrl, llm: script(click("A"), click("B")), actionOutcomes: {},
      policy: { vet: (d, ctx) => {
        vetted.push(ctx?.url);
        return ctx?.url === (d.text === "A" ? baseUrl : receipt) ? { ok: true } : { ok: false, reason: "wrong page" };
      } },
    });
    expect(driver.clicked).toEqual(["B"]);
    expect(vetted).toEqual([baseUrl, receipt]);
    expect(result.truncated).not.toBe(true);
  });

  it.each(["abort", "transport"])("treats a policy's own %s exception as a rejection without losing the run", async kind => {
    const driver = new Fixture();
    await run("try the other action", { driver, baseUrl, llm: script(click("A"), click("B")), actionOutcomes: {},
      policy: { vet: d => {
        if (d.text === "A") throw kind === "abort" ? new DOMException("host check interrupted", "AbortError") : stepError("transport", "host service offline");
        return { ok: true };
      } },
    });
    expect(driver.clicked).toEqual(["B"]);
  });

  it.each(["url", "request"])("preserves independent %s evidence without trusting duplicate references at the cap", async channel => {
    const driver = new Fixture(), statuses: string[] = [];
    const act = driver.click.bind(driver);
    driver.click = async target => {
      await act(target);
      if (channel === "url") driver.url = receipt;
      else driver.requests.push({ method: "GET", url: baseUrl + "/result", status: 200 });
      driver.els = ["A", "B"].map(name => ({ role: "button", name, ref: "duplicate" }));
    };
    const result = await run("reach receipt", { driver, baseUrl, llm: script(click("A")), maxSteps: 1,
      actionOutcomes: { onOutcome: event => statuses.push(event.status) },
      policy: { vet: () => ({ ok: true }), stop: steps => steps.length === 2 },
    });
    expect(result.truncated).toBe(true);
    expect(statuses).toEqual(["observed-change"]);
    if ("findings" in result) expect(result.findings.some(f => f.kind === "dead-action")).toBe(false);
  });

  it("traces each actual repeat veto even when later progress clears the terminal diagnostic", async () => {
    class Identified extends Fixture {
      before?: (id: string | undefined) => void;
      id?: string;
      armActionOutcomeIdentity(before: (id: string | undefined) => void) { this.before = before; this.id = undefined; }
      takeActionOutcomeIdentity() { this.before = undefined; return this.id; }
      override async click(target: Target) {
        this.before?.("private-" + target.text);
        await super.click(target);
        this.id = "private-" + target.text;
      }
    }
    const driver = new Identified(), events: TraceEvent[] = [];
    driver.navOn.B = receipt;
    const trace = startTrace({ emit: event => { events.push(event); } }, "lifecycle").scope("run");
    const result = await run("recover", { driver, baseUrl, llm: script(click("A"), click("A"), click("A"), click("B")),
      actionOutcomes: { maxRepeats: 1, recoveryTurns: 4 }, trace });
    expect(result.truncated).not.toBe(true);
    expect(driver.clicked).toEqual(["A", "B"]);
    const vetoes = events.filter(e => e.kind === "gate" && e.payload.gate === "action-no-progress");
    expect(vetoes.map(e => e.payload)).toEqual(Array(2).fill({ gate: "action-no-progress", reason: "repeated click blocked before input" }));
  });
});

it.each([false, true])("does not freeze background autosave as either click's expect (also navigates: %s)", async navigates => {
  const driver = new Fixture();
  driver.locate = async target => {
    if (target.text === "B") {
      if (navigates) driver.url = receipt;
      driver.requests.push({ method: "POST", url: baseUrl + "/autosave", status: 200 });
    }
    return target;
  };
  const act = driver.click.bind(driver);
  driver.click = async target => {
    await act(target);
    if (target.text === "B") driver.requests.push({ method: "POST", url: baseUrl + "/confirm", status: 201 });
    if (target.text === "C") driver.url = baseUrl + "/complete";
  };
  const result = await discover("inspect three controls", { driver, baseUrl, llm: script(click("A"), click("B"), click("C")), actionOutcomes: {} });
  expect(result.steps.map(s => s.expect)).toEqual([
    undefined, undefined, { requestStatus: { method: "POST", status: 201, urlIncludes: "fixture.test/cart/confirm" } }, { url: "fixture.test/cart/complete" },
  ]);
});

it.each([false, true])("ignores a POST during done but can complete one already in flight (own request: %s)", async ownRequest => {
  const driver = new Fixture();
  const act = driver.click.bind(driver);
  driver.click = async target => {
    await act(target);
    if (ownRequest) driver.requests.push({ method: "POST", url: baseUrl + "/confirm", status: 0 });
  };
  let turns = 0;
  const result = await discover("submit", { driver, baseUrl, actionOutcomes: {}, llm: { id: "done-gap", async complete(prompt) {
    if (prompt.includes("Propose the verification assertions.")) return "[]";
    if (++turns === 1) return JSON.stringify(click("A"));
    if (ownRequest) driver.requests[0]!.status = 201;
    driver.requests.push({ method: "POST", url: baseUrl + "/background", status: 200 });
    if (ownRequest) driver.url = receipt;
    return JSON.stringify(done);
  } } });
  expect(result.steps[1]!.expect).toEqual(ownRequest
    ? { requestStatus: { method: "POST", status: 201, urlIncludes: "fixture.test/cart/confirm" } }
    : undefined);
});

it("does not freeze a POST observed only after the final action was assessed", async () => {
  const driver = new Fixture();
  const result = await discover("inspect", { driver, baseUrl, maxSteps: 1, llm: script(click("A")), actionOutcomes: {
    onOutcome: () => { driver.requests.push({ method: "POST", url: baseUrl + "/autosave", status: 200 }); },
  } });
  expect(result.steps[1]!.expect).toBeUndefined();
});

it("retains a scroll on a possibly delayed load without using that request as proof", async () => {
  const driver = new Fixture();
  driver.locate = async target => {
    driver.requests.push({ method: "POST", url: baseUrl + "/load-more", status: 200 });
    return target;
  };
  const result = await discover("scroll and open", { driver, baseUrl, actionOutcomes: {},
    llm: script({ action: "scroll", direction: "down" }, click("B")) });
  expect(result.steps.map(s => s.kind)).toEqual(["goto", "scroll", "click"]);
  expect(result.steps.map(s => s.expect)).toEqual([undefined, undefined, undefined]);
});

it("collects an unassigned error that arrives while the model decides to finish", async () => {
  const driver = new Fixture();
  let turns = 0;
  const result = await explore("inspect", { driver, baseUrl, actionOutcomes: {}, llm: { id: "done-gap", async complete() {
    if (++turns === 1) return JSON.stringify(click("A"));
    driver.messages.push({ type: "error", text: "poll failed after the click was assessed" });
    return JSON.stringify(done);
  } } });
  expect(result.findings.filter(f => f.severity === "error")).toEqual([
    expect.objectContaining({ kind: "console-error", attribution: "between-actions", stepIndex: 1 }),
  ]);
});

it("reports pre-click errors once as between-actions findings; errors after input stay assigned", async () => {
  const driver = new Fixture();
  driver.locate = async target => {
    if (target.text === "B") {
      driver.requests.push({ method: "GET", url: baseUrl + "/background", status: 500 });
      driver.messages.push({ type: "error", text: "background error" });
    }
    return target;
  };
  const act = driver.click.bind(driver);
  driver.click = async target => {
    await act(target);
    if (target.text === "B") driver.messages.push({ type: "error", text: "input error" });
  };
  const seen: string[] = [];
  const result = await explore("check activity between actions", { driver, baseUrl, llm: script(click("A"), click("B")),
    actionOutcomes: {}, onFinding: f => { if (f.severity === "error") seen.push(f.key); } });
  const errors = result.findings.filter(f => f.severity === "error");
  expect(errors.map(f => [f.kind, f.stepIndex, f.attribution, f.occurrences])).toEqual([
    ["failed-request", 1, "between-actions", undefined], ["console-error", 1, "between-actions", undefined],
    ["console-error", 2, undefined, undefined],
  ]);
  expect(errors.slice(0, 2).every(f => f.detail.includes("between actions"))).toBe(true);
  expect(seen).toEqual(errors.map(f => f.key));
});

it("keeps pending requests in their original intervals when only their status changes", async () => {
  const driver = new Fixture();
  const pending = (path: string) => driver.requests.push({ method: "GET", url: `${baseUrl}/${path}`, status: 0 });
  pending("entry");
  driver.locate = async target => {
    if (target.text === "B") for (const path of ["lookup", "ignored", "retried", "success"]) pending(path);
    return target;
  };
  const act = driver.click.bind(driver);
  driver.click = async target => {
    await act(target);
    if (target.text === "A") pending("own");
    if (target.text === "B") {
      for (const r of driver.requests) r.status = r.url.endsWith("/success") ? 200 : 500;
      driver.requests.push({ method: "GET", url: baseUrl + "/retried", status: 200 });
    }
  };
  const seen: string[] = [];
  const result = await explore("inspect A and B", { driver, baseUrl, llm: script(click("A"), click("B")), maxSteps: 2,
    actionOutcomes: {}, benign: ["/ignored"], onFinding: f => { if (f.kind === "failed-request") seen.push(f.key); } });
  const failures = result.findings.filter(f => f.kind === "failed-request");
  expect(failures.map(f => [f.key.split("/").pop(), f.attribution, f.stepIndex, f.occurrences])).toEqual([
    ["entry", "between-actions", 0, undefined], ["own", undefined, 1, undefined], ["lookup", "between-actions", 1, undefined],
  ]);
  expect(seen).toEqual(failures.map(f => f.key));
});

it("bounds delayed-status tracking, keeps immediate failures and reuses completed slots", async () => {
  const driver = new Fixture();
  for (let i = 0; i < 257; i++) driver.requests.push({ method: "GET", url: baseUrl + "/" + i, status: 0 });
  driver.locate = async target => {
    driver.requests.push(target.text === "A" ? { method: "GET", url: baseUrl + "/immediate", status: 500 }
      : { method: "GET", url: baseUrl + "/later", status: 0 });
    return target;
  };
  const act = driver.click.bind(driver);
  driver.click = async target => {
    await act(target);
    if (target.text === "A") { driver.requests[0]!.status = 500; driver.requests[256]!.status = 500; }
    else driver.requests.at(-1)!.status = 500;
  };
  const result = await explore("inspect", { driver, baseUrl, llm: script(click("A"), click("B")), maxSteps: 2, actionOutcomes: {} });
  expect(result.findings.filter(f => f.kind === "failed-request").map(f => [f.key.split("/").pop(), f.attribution])).toEqual([
    ["immediate", "between-actions"], ["0", "between-actions"], ["later", "between-actions"],
  ]);
});

it.each(["rows", "bytes", "nth"] as const)("uses a valid passive render when the richer comparison is unknown: %s", async kind => {
  const driver = new Fixture();
  if (kind === "rows") driver.els.push(...Array.from({ length: 1_100 }, (_, n) => ({ role: "heading", name: String(n) })));
  if (kind === "bytes") driver.els.push(...Array.from({ length: 32 }, (_, n) => ({ role: "heading", name: String(n) + "x".repeat(1_100) })));
  if (kind === "nth") driver.els.push({ role: "button", name: "A" });
  const proposal = kind === "nth" ? { ...click("A"), nth: 1 } : click("A");
  for (const enabled of [false, true]) {
    const result = await explore("click A", { driver, baseUrl, llm: script(proposal), maxSteps: 1,
      ...(enabled ? { actionOutcomes: {} } : {}) });
    expect(result.findings.some(f => f.kind === "dead-action")).toBe(!enabled);
  }
});
