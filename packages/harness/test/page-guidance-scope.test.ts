import { describe, expect, it, vi } from "vitest";
import { discover, explore, ScopedGuidanceExpired } from "../src/index.js";
import type { DiscoverOptions, Driver, ExploreOptions, PageElement, PageGuidanceScope,
  PageGuidanceScopeFacts, Target, TraceEvent } from "../src/index.js";
import { startTrace } from "../src/core/trace.js";
import { StubDriver } from "./support/doubles.js";

const URL = "https://example.test/cart";
const target = { role: "button", name: "Checkout" };
const delivery = { role: "combobox", name: "Delivery" };
const container = { role: "group", name: "Order rows" };
const scope: PageGuidanceScope = {
  target, prerequisites: [delivery, { container, memberRole: "checkbox" }],
};
const CLICK = JSON.stringify({ action: "click", role: target.role, text: target.name });
const DONE = '{"action":"done"}';
const scopedAdvice = { text: "Check the cart", freshness: "declared-scope" } as const;
type Mode = "discover" | "explore";

class Cart extends StubDriver {
  constructor(private otherButton = "Other") { super(URL); }
  slide = 1;
  destination = "private-standard";
  rows = ["private-row-1", "private-row-2"];
  checked = false;
  disabled = false;
  occluded = false;
  duplicate = false;
  measurable = true;
  measureOutside = false;
  issueReceipt = true;
  missingTarget = false;
  targetId = "private-checkout";
  documentId = "private-document";
  ref?: string;
  snapshotCalls = 0;
  scopedCalls = 0;
  private receipt?: { token: string; delivery: string };

  override async click(target: Target, ref?: string, checkBeforeDispatch?: () => void) {
    if (ref?.startsWith("private-receipt-")) {
      if (ref !== this.receipt?.token) throw new ScopedGuidanceExpired({ scopeStatus: "scope-unverifiable" });
      if (this.destination !== this.receipt.delivery) throw new ScopedGuidanceExpired({ scopeStatus: "scope-changed" });
      checkBeforeDispatch?.();
    }
    await super.click(target);
  }

  private listing(): PageElement[] {
    const button = { ...target, disabled: this.disabled, occluded: this.occluded,
      ...(this.ref ? { ref: this.ref } : {}) };
    return [...(this.missingTarget ? [] : [button]), ...(this.duplicate ? [{ ...button }] : []),
      { role: "button", name: this.otherButton }, { ...delivery, value: this.destination }, container,
      ...this.rows.map(() => ({ role: "checkbox", name: "Select", checked: this.checked })),
      { role: "link", name: `Promo ${this.slide}` }];
  }
  override async snapshot() { this.snapshotCalls++; return this.listing(); }
  async snapshotWithGuidanceScope(_scope: PageGuidanceScope) {
    this.scopedCalls++;
    const node = { ...target, id: this.targetId, disabled: this.disabled, occluded: this.occluded };
    const facts: PageGuidanceScopeFacts = {
      complete: true, documentId: this.documentId,
      targets: this.missingTarget ? [] : this.duplicate ? [node, { ...node, id: "private-second" }] : [node],
      ...(this.measureOutside && { outside: [
        { role: "button", name: "Other", id: "private-other" },
        { role: "link", name: `Promo ${this.slide}`, id: "private-promo" },
      ] }),
      prerequisites: [
        { members: [{ ...delivery, id: "private-delivery", value: this.destination, disabled: false }] },
        { containerId: "private-cart", members: this.rows.map(id => ({
          id, role: "checkbox", name: "Select", checked: this.checked, disabled: false,
        })) },
      ],
    };
    this.receipt = this.issueReceipt ? { token: `private-receipt-${this.scopedCalls}`, delivery: this.destination } : undefined;
    return { elements: this.listing(), ...(this.measurable ? { facts } : {}),
      ...(this.receipt && { targetRef: this.receipt.token }) };
  }
}

// Move the page or stop the run while the driver's final freshness read is in flight.
function afterFinalCapture(driver: Cart, change: () => void) {
  const capture = driver.snapshotWithGuidanceScope.bind(driver);
  driver.snapshotWithGuidanceScope = async s => {
    const frame = await capture(s);
    if (driver.scopedCalls === 2) change();
    return frame;
  };
}

type Options = Pick<DiscoverOptions & ExploreOptions, "pageGuidance" | "pageGuidanceScope" | "maxSteps" | "signal" | "policy" | "budget">;
async function run(mode: Mode, driver: Driver, reply: (n: number, prompt: string) => string,
  options: Partial<Options> = {}) {
  const events: TraceEvent[] = [];
  const trace = startTrace({ emit: event => { events.push(event); } }, "scope").scope("cart");
  let calls = 0, proposals = 0;
  const model = { id: "scripted", async complete(prompt: string) {
    if (prompt.includes("Propose the verification assertions.")) { proposals++; return "[]"; }
    return reply(++calls, prompt);
  } };
  const opts = { driver, llm: model, baseUrl: URL, trace, maxSteps: 1,
    pageGuidanceScope: scope, pageGuidance: () => scopedAdvice, ...options };
  const result = await (mode === "discover" ? discover("Check out", opts) : explore("Check out", opts));
  const gates = events.flatMap(e => e.kind === "gate" && e.payload.gate === "page-guidance" ? [e.payload] : []);
  return { result, calls, proposals, gates, events };
}

describe.each(["discover", "explore"] as const)("%s reference-free scoped guidance", mode => {
  it("clicks once when only a promotion changes and finishes with a fresh decision", async () => {
    const driver = new Cart();
    let rawSnapshotsAtClick: number | undefined;
    const click = driver.click.bind(driver);
    driver.click = async (...args) => { rawSnapshotsAtClick = driver.snapshotCalls; await click(...args); };
    const visible: string[] = [];
    const { result, calls, gates, events } = await run(mode, driver, (n, prompt) => {
      visible.push(prompt);
      if (n === 1) { driver.slide++; return CLICK; }
      return DONE;
    }, { maxSteps: 3, pageGuidance: request => { visible.push(JSON.stringify(request)); return scopedAdvice; } });
    expect(result.truncated).not.toBe(true);
    expect(calls).toBe(2);
    expect(driver.clicked).toEqual(["Checkout"]);
    expect(rawSnapshotsAtClick).toBe(0); // Combined captures already supply the perception rows.
    expect(gates).toEqual([]);
    expect(JSON.stringify([visible, events, result])).not.toMatch(/private-(?:row|cart|checkout|delivery|document)/);
  });

  const changes: [string, (cart: Cart) => void, string][] = [
    ["delivery option", d => { d.destination = "private-express"; }, "scope-changed"],
    ["checked state", d => { d.checked = true; }, "scope-changed"],
    ["replacement with the same count, role, name and state", d => { d.rows[0] = "private-replacement"; }, "scope-changed"],
    ["member addition", d => { d.rows.push("private-third"); }, "scope-changed"],
    ["member removal", d => { d.rows.pop(); }, "scope-changed"],
    ["new document at the same URL", d => { d.documentId = "private-new-document"; }, "scope-changed"],
    ["newly disabled target", d => { d.disabled = true; }, "scope-changed"],
    ["newly occluded target", d => { d.occluded = true; }, "scope-changed"],
    ["duplicate target", d => { d.duplicate = true; }, "target-ambiguous"],
    ["missing facts", d => { d.measurable = false; }, "scope-unverifiable"],
    ["empty required set", d => { d.rows.length = 0; }, "scope-unverifiable"],
  ];
  it.each(changes)("rejects the stale click: %s", async (_case, change, scopeStatus) => {
    const driver = new Cart();
    const { gates } = await run(mode, driver, () => { change(driver); return CLICK; });
    expect(driver.clicked).toEqual([]);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ scopeStatus });
    expect(JSON.stringify(gates)).not.toMatch(/private-|Checkout|Select|Delivery|Promo/);
  });

  it.each(["target", "prerequisite"])("rejects a change to the %s during final scope resolution", async which => {
    const driver = new Cart();
    const capture = driver.snapshotWithGuidanceScope.bind(driver);
    driver.snapshotWithGuidanceScope = async s => {
      if (driver.scopedCalls === 1) {
        if (which === "target") driver.targetId = "private-replacement"; else driver.destination = "private-express";
      }
      return capture(s);
    };
    const { gates } = await run(mode, driver, () => CLICK);
    expect(driver.clicked).toEqual([]);
    expect(gates).toContainEqual(expect.objectContaining({ scopeStatus: "scope-changed" }));
  });

  it("dispatches with the latest receipt and never saves an ordinal from an earlier layout", async () => {
    const driver = new Cart();
    const locate = vi.spyOn(driver, "locate").mockImplementation(async t => ({ ...t, index: 3 }));
    const click = vi.spyOn(driver, "click");
    const visible: string[] = [];
    const { events, result } = await run(mode, driver, (_n, prompt) => { visible.push(prompt); return CLICK; });
    expect(click).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledWith({ role: target.role, text: target.name }, "private-receipt-2", expect.any(Function));
    expect(locate).not.toHaveBeenCalled();
    expect(result.steps).toContainEqual(expect.objectContaining({
      kind: "click", target: { role: target.role, text: target.name },
    }));
    const saved = result.steps.find(s => s.kind === "click");
    expect(saved && "target" in saved && saved.target).toEqual({ role: target.role, text: target.name });
    expect(JSON.stringify([visible, events, result])).not.toContain("private-receipt");
  });

  it("counts a pre-dispatch expiration without leaking a driver's annotation", async () => {
    const driver = new Cart();
    driver.click = async () => {
      const expired = new ScopedGuidanceExpired({ scopeStatus: "scope-unverifiable" });
      expired.message += " private-driver-path";
      throw expired;
    };
    const { events, result } = await run(mode, driver, () => CLICK, { maxSteps: 8 });
    expect(result.truncationReason).toBe("page-guidance-expired");
    expect(result.steps).not.toContainEqual(expect.objectContaining({ kind: "click" }));
    expect(JSON.stringify([result, events])).not.toContain("private-driver-path");
  });

  it.each([false, true])("does not dispatch stale delivery after the last capture (driver issues a receipt: %s)", async hasReceipt => {
    const driver = new Cart();
    driver.issueReceipt = hasReceipt;
    // Returning a complete set of facts is not a promise that those facts still hold at input.
    // This URL read is asynchronous and happens after the engine's second capture.
    const observe = driver.observe.bind(driver);
    driver.observe = async () => {
      if (driver.scopedCalls === 2) driver.destination = "private-express";
      return observe();
    };
    const click = vi.spyOn(driver, "click");
    const { gates } = await run(mode, driver, () => CLICK);
    expect(driver.clicked).toEqual([]);
    expect(gates[0]?.scopeStatus).toBe(hasReceipt ? "scope-changed" : "scope-unverifiable");
    if (!hasReceipt) expect(click).not.toHaveBeenCalled();
  });

  it.each(["missing", "ambiguous"] as const)("counts final target resolution as expiration when the target is %s", async condition => {
    const driver = new Cart();
    const capture = driver.snapshotWithGuidanceScope.bind(driver);
    driver.snapshotWithGuidanceScope = async s => {
      const atDispatch = driver.scopedCalls % 2 === 1;
      driver.missingTarget = atDispatch && condition === "missing";
      driver.duplicate = atDispatch && condition === "ambiguous";
      return capture(s);
    };
    // Ordinary name lookup may throw on no match or select an ordinal among duplicates.
    // Neither is a valid substitute for the final scoped resolution.
    const locate = vi.spyOn(driver, "locate").mockImplementation(async t => {
      if (condition === "missing") throw Object.assign(new Error("private-no-match"), { kind: "resolution" });
      return { ...t, nth: 0 };
    });
    const { result, gates, calls, events } = await run(mode, driver, () => CLICK, { maxSteps: 7 });
    expect(locate).not.toHaveBeenCalled();
    expect(calls).toBe(3);
    expect(result.truncationReason).toBe("page-guidance-expired");
    expect(gates.filter(g => g.scopeStatus === (condition === "missing" ? "scope-unverifiable" : "target-ambiguous"))).toHaveLength(3);
    expect(driver.clicked).toEqual([]);
    expect(events.some(e => e.kind === "action" && !e.payload.ok)).toBe(false);
    if ("findings" in result) expect(result.findings.some(f => f.kind === "action-error")).toBe(false);
  });

  it.each(["capture", "dispatch"])("preserves transport failure during final %s without retrying the decision", async stage => {
    const driver = new Cart();
    const disconnected = Object.assign(new Error("session disconnected"), { kind: "transport" });
    let replies = 0, reads = 0;
    const capture = driver.snapshotWithGuidanceScope.bind(driver);
    driver.snapshotWithGuidanceScope = async s => {
      if (stage === "capture" && ++reads % 2 === 0) throw disconnected;
      return capture(s);
    };
    if (stage === "dispatch") driver.click = async () => { throw disconnected; };
    await expect(run(mode, driver, () => { replies++; return CLICK; }, { maxSteps: 7 })).rejects.toBe(disconnected);
    expect(replies).toBe(1);
    expect(driver.clicked).toEqual([]);
  });

  it("does not dispatch a scoped click retargeted by a policy callback", async () => {
    const driver = new Cart();
    const { gates } = await run(mode, driver, () => CLICK, { policy: {
      vet(d) { d.text = "Other"; return { ok: true }; },
    } });
    expect(driver.clicked).toEqual([]);
    expect(gates[0]?.scopeStatus).toBe("scope-unverifiable");
  });

  it("only classifies a resolution error as expiration before dispatch", async () => {
    const driver = new Cart();
    let reads = 0;
    const capture = driver.snapshotWithGuidanceScope.bind(driver);
    const error = Object.assign(new Error("private missing browser node"), { kind: "resolution" });
    driver.snapshotWithGuidanceScope = async s => {
      if (++reads % 2 === 0) throw error;
      return capture(s);
    };
    const { calls, gates, result } = await run(mode, driver, () => CLICK, { maxSteps: 7 });
    expect(result.truncationReason).toBe("page-guidance-expired");
    expect(calls).toBe(3);
    expect(gates.filter(g => g.scopeStatus === "scope-unverifiable")).toHaveLength(3);
    expect(JSON.stringify(gates)).not.toContain(error.message);
    expect(driver.clicked).toEqual([]);

    // The very same error after an input might mean the click reached the page.
    // It is not proof of non-dispatch and must not lead to another attempt.
    driver.snapshotWithGuidanceScope = capture;
    const click = driver.click.bind(driver);
    driver.click = async (...args) => { await click(...args); throw error; };
    const partial = await run(mode, driver, () => CLICK, { maxSteps: 7 });
    expect(partial.result.truncationReason).toBe("click-dispatch-uncertain");
    expect(partial.calls).toBe(1);
    expect(driver.clicked).toEqual(["Checkout"]);
  });

  it("does not attribute an unacknowledged Checkout's destination or POST to the confirmed Start step", async () => {
    const driver = new Cart("Start");
    const receipt = "https://example.test/private-receipt";
    const orderPost = { method: "POST", url: "https://example.test/private-orders", status: 201 };
    const requests: (typeof orderPost)[] = [];
    const readsAfterSend: string[] = [];
    const observe = driver.observe.bind(driver);
    driver.observe = async () => {
      if (requests.length) readsAfterSend.push("observe");
      const evidence = await observe();
      evidence.logic.requests = requests.slice();
      return evidence;
    };
    const click = driver.click.bind(driver);
    driver.click = async (...args) => {
      await click(...args); // Includes the Driver's check immediately before submission.
      if (args[0].text !== "Checkout") return;
      driver.url = receipt;
      requests.push(orderPost);
      throw new Error("private lost Checkout response");
    };
    const { result, calls, proposals, events, gates } = await run(mode, driver, n => {
      if (n === 1) return '{"action":"click","role":"button","text":"Start"}';
      if (mode === "explore" && n === 2) return '{"action":"note","text":"Delivery description is unclear"}';
      return CLICK;
    }, { maxSteps: 8, policy: {
      vet: () => ({ ok: true }),
      stop: () => { if (requests.length) readsAfterSend.push("stop"); return driver.url === receipt; },
    } });
    expect(driver.clicked).toEqual(["Start", "Checkout"]);
    expect(requests).toEqual([orderPost]);
    expect(result).toMatchObject({ truncated: true, truncationReason: "click-dispatch-uncertain" });
    expect(result.steps).toMatchObject([{ kind: "goto", url: URL }, { kind: "click", target: { text: "Start" } }]);
    expect(result.steps[1]).not.toHaveProperty("expect");
    expect(readsAfterSend).toEqual([]);
    expect(calls).toBe(mode === "discover" ? 2 : 3);
    expect(proposals).toBe(0);
    if ("assertions" in result) expect(result.assertions).toEqual([]);
    if ("findings" in result) {
      expect(result.findings).toContainEqual(expect.objectContaining({ kind: "agent-note", detail: "Delivery description is unclear" }));
      expect(result.findings.some(f => f.kind === "action-error")).toBe(false);
      expect(result.finalUrl).toBe(URL);
    }
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ code: "click-dispatch-uncertain" });
    expect(JSON.stringify(gates)).not.toMatch(/Checkout|Start|private|receipt|example\.test/);
    expect(JSON.stringify([result, events])).not.toMatch(/private-receipt|private-orders|private lost Checkout response/);
    expect(events.some(e => e.kind === "action" && e.payload.ok &&
      (e.payload.done || (e.payload.step?.kind === "click" && e.payload.step.target.text === "Checkout")))).toBe(false);
  });

  it("cannot retry an expiration a Driver reports after input was submitted", async () => {
    const driver = new Cart();
    const click = driver.click.bind(driver);
    driver.click = async (...args) => {
      await click(...args);
      throw new ScopedGuidanceExpired({ scopeStatus: "target-ambiguous" });
    };
    const { result, calls } = await run(mode, driver, () => CLICK, { maxSteps: 8 });
    expect(result.truncationReason).toBe("click-dispatch-uncertain");
    expect(calls).toBe(1);
    expect(driver.clicked).toEqual(["Checkout"]);
  });

  it("propagates an ordinary Driver error before the pre-send check", async () => {
    const driver = new Cart(), error = new Error("cannot read active page");
    driver.click = async () => { throw error; };
    await expect(run(mode, driver, () => CLICK)).rejects.toBe(error);
    expect(driver.clicked).toEqual([]);
  });

  it("retains ordinary failure handling when the host chooses plain advice", async () => {
    const driver = new Cart(), failClick = vi.spyOn(driver, "click").mockRejectedValue(new Error("not interactable"));
    const { result, calls } = await run(mode, driver, n => n === 1 ? CLICK : DONE,
      { maxSteps: 4, pageGuidance: () => scopedAdvice.text });
    expect(failClick).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
    expect(result.truncated).not.toBe(true);
    expect(result.steps.map(s => s.kind)).toEqual(["goto"]);
    if ("findings" in result) expect(result.findings.some(f => f.kind === "action-error")).toBe(true);
  });

  it.each(["transport", "cancel", "deadline"])("preserves %s after the pre-send check", async failure => {
    const driver = new Cart(), controller = new AbortController();
    const error = Object.assign(new Error("connection closed"), { kind: "transport" });
    const abort = new Error("run cancelled");
    const click = driver.click.bind(driver);
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      driver.click = async (...args) => {
        await click(...args);
        if (failure === "transport") throw error;
        if (failure === "cancel") controller.abort(abort);
        if (failure === "deadline") now += 1001;
        throw new Error("no acknowledgment");
      };
      const result = run(mode, driver, () => CLICK, { signal: controller.signal, budget: { timeoutMs: 1000 } });
      if (failure === "deadline") await expect(result).rejects.toMatchObject({ name: "BudgetExceededError", budget: { limit: "time" } });
      else await expect(result).rejects.toBe(failure === "transport" ? error : abort);
      expect(driver.clicked).toEqual(["Checkout"]);
    } finally { clock.mockRestore(); }
  });

  it.each([
    ["null receipt", { targetRef: null }],
    ["empty receipt", { targetRef: "" }],
    ["non-string receipt", { targetRef: 27 }],
    ["incomplete fresh facts", { facts: { complete: false, documentId: "private-document" } }],
  ])("does not dispatch on malformed driver data: %s", async (_label, invalid) => {
    const driver = new Cart();
    const capture = driver.snapshotWithGuidanceScope.bind(driver);
    driver.snapshotWithGuidanceScope = async s => {
      const frame = await capture(s);
      // A third-party JavaScript driver is not constrained by the port's TypeScript types.
      return driver.scopedCalls === 1 ? frame : { ...frame, ...invalid } as typeof frame;
    };
    const { gates } = await run(mode, driver, () => CLICK);
    expect(driver.clicked).toEqual([]);
    expect(gates).toContainEqual(expect.objectContaining({ scopeStatus: "scope-unverifiable" }));
  });

  it("reports only counts when changes occur inside and outside the scope", async () => {
    const driver = new Cart();
    driver.measureOutside = true;
    const { gates } = await run(mode, driver, () => {
      driver.slide++;
      driver.destination = "private-express";
      return CLICK;
    });
    expect(driver.clicked).toEqual([]);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      scopeStatus: "scope-changed", targetUnambiguous: true,
      addedInside: 0, removedInside: 0, changedInside: 1,
      addedOutside: 0, removedOutside: 0, changedOutside: 1,
    });
    expect(JSON.stringify(gates[0])).not.toMatch(/private-|Checkout|Delivery|Select|Promo/);
    expect(driver.snapshotCalls).toBe(0);
  });

  it("does not dispatch when the URL changes during the final scope capture", async () => {
    const driver = new Cart();
    afterFinalCapture(driver, () => { driver.url = URL + "/other"; });
    const { gates } = await run(mode, driver, () => CLICK);
    expect(driver.clicked).toEqual([]);
    expect(gates).toContainEqual(expect.objectContaining({ reason: expect.stringContaining("URL changed") }));
  });

  it("propagates cancellation during the final scope capture", async () => {
    const driver = new Cart();
    const controller = new AbortController();
    const reason = new Error("stop");
    afterFinalCapture(driver, () => controller.abort(reason));
    await expect(run(mode, driver, () => CLICK, { signal: controller.signal })).rejects.toBe(reason);
    expect(driver.clicked).toEqual([]);
  });

  it("charges the last scoped capture to the same run deadline", async () => {
    const driver = new Cart();
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      afterFinalCapture(driver, () => { now += 1001; });
      await expect(run(mode, driver, () => CLICK, { budget: { timeoutMs: 1000 } }))
        .rejects.toMatchObject({ name: "BudgetExceededError", budget: { limit: "time", modelCalls: 1 } });
      expect(driver.clicked).toEqual([]);
    } finally { clock.mockRestore(); }
  });

  it("honors cancellation after the driver has awaited its final receipt validation", async () => {
    const driver = new Cart(), controller = new AbortController(), reason = new Error("stop");
    const dispatch = driver.click.bind(driver);
    const adapter: Driver = driver;
    adapter.click = async (target, _ref, checkBeforeDispatch) => {
      await Promise.resolve();
      controller.abort(reason);
      checkBeforeDispatch?.();
      await dispatch(target);
    };
    await expect(run(mode, adapter, () => CLICK, { signal: controller.signal })).rejects.toBe(reason);
    expect(driver.clicked).toEqual([]);
  });

  it("does not trust stable scope facts that contradict the fresh target listing", async () => {
    const driver = new Cart();
    const capture = driver.snapshotWithGuidanceScope.bind(driver);
    driver.snapshotWithGuidanceScope = async s => {
      const frame = await capture(s);
      if (driver.scopedCalls === 2) frame.elements.push({ ...target });
      return frame;
    };
    const { gates } = await run(mode, driver, () => CLICK);
    expect(driver.clicked).toEqual([]);
    expect(gates[0]).toMatchObject({ scopeStatus: "target-ambiguous" });
  });

  it("still lets the host policy reject a fresh scoped click", async () => {
    const driver = new Cart(), vet = vi.fn(() => ({ ok: false as const, reason: "host denied" }));
    await run(mode, driver, () => { driver.slide++; return CLICK; }, { policy: { vet } });
    expect(vet).toHaveBeenCalledOnce();
    expect(driver.clicked).toEqual([]);
  });

  it("does not accept missing scope facts just because all perception rows look unchanged", async () => {
    const driver = new StubDriver(URL);
    driver.els = [target, delivery, container, { role: "checkbox", name: "Select" }];
    const { result, gates } = await run(mode, driver, () => CLICK, { maxSteps: 8 });
    expect(driver.clicked).toEqual([]);
    expect(result.truncationReason).toBe("page-guidance-expired");
    expect(gates.filter(g => "scopeStatus" in g && g.scopeStatus === "scope-unverifiable")).toHaveLength(3);
    // Plain advice is an explicit choice by the host, not an engine downgrade.
    await run(mode, driver, () => CLICK, { pageGuidance: () => scopedAdvice.text });
    expect(driver.clicked).toEqual(["Checkout"]);
  });

  it("rejects a malformed opt-in before navigation or capture", async () => {
    const driver = new Cart();
    const goto = vi.spyOn(driver, "goto");
    const observe = vi.spyOn(driver, "observe");
    const opts = { pageGuidanceScope: { target, prerequisites: [] } };
    await expect(run(mode, driver, () => CLICK, opts)).rejects.toThrow(TypeError);
    expect(goto).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(driver.scopedCalls + driver.snapshotCalls).toBe(0);
    expect(driver.clicked).toEqual([]);
  });

  it("does not ask the driver for scoped facts without a guidance provider", async () => {
    const driver = new Cart();
    await run(mode, driver, () => { driver.slide++; return CLICK; }, { pageGuidance: undefined });
    expect(driver.scopedCalls).toBe(0);
    expect(driver.clicked).toEqual(["Checkout"]);
  });

  it("does not apply a previous scope opt-in to a later plain-text guidance response", async () => {
    const driver = new Cart();
    let observations = 0;
    const { calls, gates } = await run(mode, driver, () => { driver.slide++; return CLICK; }, {
      maxSteps: 2, pageGuidance: () => ++observations === 1 ? scopedAdvice : scopedAdvice.text,
    });
    expect(calls).toBe(2);
    expect(driver.clicked).toEqual(["Checkout"]);
    expect(gates).toContainEqual(expect.objectContaining({ reason: expect.stringContaining("elements changed") }));
  });

  it("retains URL validation when scoped facts still match", async () => {
    const driver = new Cart();
    const { gates } = await run(mode, driver, () => { driver.url = URL + "/other"; return CLICK; });
    expect(driver.clicked).toEqual([]);
    expect(gates).toContainEqual(expect.objectContaining({ reason: expect.stringContaining("URL changed") }));
  });

  it.each([
    ["done", DONE],
    ["an undeclared target", '{"action":"click","role":"button","text":"Other"}'],
    ["an unqualified target", '{"action":"click","text":"Checkout"}'],
    ["an ordinal target", '{"action":"click","role":"button","text":"Checkout","nth":0}'],
  ])("retains whole-page validation for %s", async (_name, decision) => {
    const driver = new Cart();
    const { gates, result } = await run(mode, driver, () => { driver.slide++; return decision; });
    expect(driver.clicked).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(gates).toContainEqual(expect.objectContaining({ reason: expect.stringContaining("elements changed") }));
  });

  it("starts from the current set in a new invocation and does not retain a previous scope", async () => {
    const driver = new Cart();
    await run(mode, driver, () => { driver.slide++; return CLICK; });
    driver.rows.push("private-new-run");
    await run(mode, driver, () => { driver.slide++; return CLICK; });
    expect(driver.clicked).toEqual(["Checkout", "Checkout"]);
    const prior = driver.scopedCalls;
    const { gates } = await run(mode, driver, () => { driver.slide++; return CLICK; }, {
      pageGuidanceScope: undefined, pageGuidance: () => scopedAdvice.text,
    });
    expect(driver.clicked).toEqual(["Checkout", "Checkout"]);
    expect(driver.scopedCalls).toBe(prior);
    expect(gates).toContainEqual(expect.objectContaining({ reason: expect.stringContaining("elements changed") }));
  });

  it("keeps Driver refs on the existing exact-node path", async () => {
    const driver = new class extends Cart {
      async locateRef() { return { role: "button", text: "Checkout" }; }
    }();
    driver.ref = "private-ref";
    const click = vi.spyOn(driver, "click");
    await run(mode, driver, (_n, prompt) => {
      const ref = /ref="([^"]+)"/.exec(prompt)?.[1];
      expect(ref).toBeTruthy();
      driver.slide++;
      return JSON.stringify({ action: "click", ref });
    });
    expect(click).toHaveBeenCalledWith(expect.objectContaining({ text: "Checkout" }), driver.ref);
  });
});

it("propagates a failed scoped discovery observation before policy or click", async () => {
  const driver = new Cart(), error = new Error("page observation failed");
  const observe = driver.observe.bind(driver);
  const vet = vi.fn(() => ({ ok: true as const }));
  let decided = false, postDecisionReads = 0;
  driver.observe = async () => {
    // The post-response URL check succeeds; the action's pre-policy read then fails.
    if (decided && ++postDecisionReads === 2) throw error;
    return observe();
  };
  await expect(run("discover", driver, () => { decided = true; return CLICK; }, { policy: { vet } })).rejects.toBe(error);
  expect(vet).not.toHaveBeenCalled();
  expect(driver.clicked).toEqual([]);
});

it("keeps exploration notes observation-wide", async () => {
  const driver = new Cart();
  const { result, gates } = await run("explore", driver, () => {
    driver.slide++; return '{"action":"note","text":"private-stale-note"}';
  });
  expect(JSON.stringify(result)).not.toContain("private-stale-note");
  expect(gates).toContainEqual(expect.objectContaining({ reason: expect.stringContaining("elements changed") }));
});
