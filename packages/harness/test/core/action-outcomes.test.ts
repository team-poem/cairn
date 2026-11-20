import { describe, expect, it } from "vitest";
import { ActionOutcomeTracker, type ActionOutcomeOptions } from "../../src/core/action-outcomes.js";
import type { Driver, PageElement } from "../../src/index.js";

const target = { role: "checkbox", name: "Delivery", checked: false };
const label = { role: "heading", name: "Summary" };
const click = { kind: "click", target: { role: target.role, text: target.name } } as const;
const url = "https://app.test";

describe("bounded action outcome comparisons", () => {
  it("includes the acted control when the declared rows do not include it", () => {
    const tracker = new ActionOutcomeTracker({ maxRepeats: 1, scope: rows => rows.filter(r => r.role === "heading") });
    tracker.executed(click, tracker.capture([target, label], url, 2), "node", 0);
    expect(tracker.observe(tracker.capture([{ ...target, checked: true }, label], url, 2))).toBe("observed-change");
    expect(tracker.suspect).toBe(false);
  });

  it.each([
    { name: "ambiguous target", rows: [target, { ...target }, label], scope: (rows: readonly PageElement[]) => rows },
    { name: "foreign rows", rows: [target, label], scope: () => [label] },
    { name: "duplicate rows", rows: [target, label], scope: (rows: readonly PageElement[]) => [rows[0]!, rows[0]!] },
    { name: "missing required rows", rows: [target, label], scope: () => [] },
    { name: "unavailable host", rows: [target, label], scope: () => { throw new Error("host unavailable"); } },
    { name: "sparse result", rows: [target, label], scope: () => Array<PageElement>(1) },
    { name: "oversized", rows: Array<PageElement>(513).fill(target) },
    { name: "oversized value", rows: [{ ...target, value: "x".repeat(32769) }] },
  ])("does not enforce repetition on $name", ({ rows, scope }) => {
    const tracker = new ActionOutcomeTracker({ scope, maxRepeats: 1 });
    const frame = tracker.capture(rows, url, 1);
    tracker.executed(click, frame, "node", 1);
    expect(tracker.observe(frame)).toBe("insufficient-evidence");
    expect(tracker.suspect).toBe(false);
  });

  it.each([{ maxRepeats: -1 }, { maxRepeats: 33 }, { recoveryTurns: 17 }, { recoveryTurns: 1.5 }])(
    "rejects invalid limits %o", opts => expect(() => new ActionOutcomeTracker(opts as ActionOutcomeOptions)).toThrow(RangeError));

  it("does not turn a mismatched or unreadable receipt into repeat evidence", () => {
    const tracker = new ActionOutcomeTracker({});
    for (const take of [() => "replacement", () => { throw Error("missing receipt"); }]) {
      const driver = { armActionOutcomeIdentity(cb: (id: string) => void) { cb("original"); },
        takeActionOutcomeIdentity: take } as unknown as Driver;
      tracker.arm(driver, { action: "click" }, () => {});
      expect(tracker.take(driver, { action: "click" })).toBeUndefined();
    }
  });

  it("distinguishes the identity check, a pre-send veto, and the first actual input", () => {
    const tracker = new ActionOutcomeTracker({});
    let identify: ((id: string) => void) | undefined, send: (() => void) | undefined, cancelled = false;
    const driver = {
      armActionOutcomeDispatch(cb: () => void) { send = cb; },
      clearActionOutcomeDispatch() { send = undefined; },
      armActionOutcomeIdentity(cb: (id: string) => void) { identify = cb; },
      takeActionOutcomeIdentity() { identify = undefined; throw Error("lost receipt"); },
    } as unknown as Driver;
    const check = () => { if (cancelled) throw Error("cancelled"); };
    tracker.arm(driver, { action: "click" }, check);
    tracker.beforeDriverInput();
    identify!("node");
    expect(tracker.dispatchUncertain).toBeUndefined();
    cancelled = true;
    expect(() => send!()).toThrow("cancelled");
    expect(tracker.dispatchUncertain).toBeUndefined();
    tracker.take(driver, { action: "click" });
    expect(identify).toBeUndefined();
    expect(send).toBeUndefined();

    cancelled = false;
    tracker.arm(driver, { action: "select" }, check);
    tracker.beforeDriverInput();
    expect(tracker.dispatchUncertain).toBeUndefined();
    send!(); // opened the popup; an option lookup or second input can still fail
    cancelled = true;
    expect(() => send!()).toThrow("cancelled");
    tracker.take(driver, { action: "select" });
    expect(send).toBeUndefined();
    expect(tracker.dispatchUncertain).toBe("action-dispatch-uncertain");
  });

  it("disarms both observers if registration only partially succeeds", () => {
    let dispatchArmed = false, identityArmed = false;
    const driver = {
      armActionOutcomeDispatch() { dispatchArmed = true; }, clearActionOutcomeDispatch() { dispatchArmed = false; },
      armActionOutcomeIdentity() { identityArmed = true; throw Error("arm failed"); },
      takeActionOutcomeIdentity() { identityArmed = false; },
    } as unknown as Driver;
    const tracker = new ActionOutcomeTracker({});
    expect(() => tracker.arm(driver, { action: "click" }, () => {})).toThrow("arm failed");
    expect([dispatchArmed, identityArmed]).toEqual([false, false]);
    expect(tracker.dispatchUncertain).toBeUndefined();
  });

  it("requires a unique exact role/name match and never infers an ordinal from a partial listing", () => {
    const tracker = new ActionOutcomeTracker({ maxRepeats: 1, scope: rows => rows.filter(r => r.role === "heading") });
    const frame = tracker.capture([label, target, { role: "button", name: target.name.toUpperCase() }], url, 0);
    for (const candidate of [{ text: "delivery" }, { role: "link", text: "Delivery" },
      { ...click.target, nth: 0 }, { ...click.target, nth: 1 }, { ...click.target, selector: "#unverified" }]) {
      tracker.executed({ kind: "click", target: candidate }, frame, "node", 0);
      expect(tracker.observe(frame)).toBe("insufficient-evidence");
      expect(tracker.suspect).toBe(false);
    }
    tracker.executed({ kind: "click", target: { role: "checkbox", text: " DELIVERY " } }, frame, "node", 0);
    expect(tracker.observe(frame)).toBe("no-observed-change");
  });

  it("abstains when the captured rows omit the acted control, even without a declared scope", () => {
    const tracker = new ActionOutcomeTracker({ maxRepeats: 1 });
    const frame = tracker.capture([label], url, 0);
    tracker.executed(click, frame, "node", 0);
    expect(tracker.observe(frame)).toBe("insufficient-evidence");
    expect(tracker.suspect).toBe(false);
  });

  it("does not clear a repeat limit when an optional measurement becomes unavailable", () => {
    const tracker = new ActionOutcomeTracker({ maxRepeats: 1 });
    const frame = tracker.capture([{ ...target, occluded: false }], url, 0);
    tracker.executed(click, frame, "node", 0);
    expect(tracker.observe(frame)).toBe("no-observed-change");
    tracker.observe(tracker.capture([target], url, 0));
    expect(tracker.suspect).toBe(true);
    // Another change to the same row is still observable.
    tracker.observe(tracker.capture([{ ...target, checked: true }], url, 0));
    expect(tracker.suspect).toBe(false);
  });

  it("keeps a positive change in the declared scope after the clicked button disappears", () => {
    const tracker = new ActionOutcomeTracker({ maxRepeats: 1, scope: rows => rows.filter(r => r.role === "heading") });
    tracker.executed(click, tracker.capture([label, target], url, 0), "node", 0);
    expect(tracker.observe(tracker.capture([{ ...label, value: "ready" }], url, 0))).toBe("insufficient-evidence");
    tracker.executed(click, tracker.capture([{ ...label, value: "loading" }, target], url, 0), "node", 1);
    expect(tracker.observe(tracker.capture([{ ...label, value: "ready" }], url, 0))).toBe("observed-change");
  });

  it("joins host corrections within a capture, even when the host reorders identical names", () => {
    let calls = 0;
    const tracker = new ActionOutcomeTracker({ scope: rows => { calls++; return rows; } });
    const raw = [{ ...target, ref: "r1" }, { ...target, ref: "r2" }];
    const before = tracker.capture(raw, url, 0, [raw[1]!, raw[0]!]);
    // Both driver refs rotate; the host changes only the second raw node's measured state.
    const after = raw.map((e, i) => ({ ...e, ref: "new" + i }));
    tracker.executed(click, before, "node", 0);
    expect(tracker.observe(tracker.capture(after, url, 0, [after[0]!, { ...after[1]!, checked: true }]))).toBe("observed-change");
    expect(calls).toBe(2);
  });

  it("preserves raw observations that host perception omitted, and abstains on unbindable corrections", () => {
    const tracker = new ActionOutcomeTracker({ maxRepeats: 1 });
    tracker.executed(click, tracker.capture([target, label], url, 0, [target]), "node", 0);
    expect(tracker.observe(tracker.capture([target, { ...label, name: "Ready" }], url, 0, [target]))).toBe("observed-change");
    const unbound = tracker.capture([target, label], url, 0, [{ ...target, ref: "foreign" }]);
    tracker.executed(click, unbound, "node", 1);
    expect(tracker.observe(unbound)).toBe("insufficient-evidence");
    expect(tracker.suspect).toBe(false);
  });

  it("does not ignore ambiguous, foreign or possibly missing host corrections inside a scope", () => {
    const tracker = new ActionOutcomeTracker({ scope: rows => rows.filter(r => r.role === "heading") });
    const extra = { role: "status", name: "Host banner" };
    for (const perceived of [[label, extra], [target, label, { ...extra, ref: "foreign" }],
      [target, label, { ...target, checked: true }]]) {
      const frame = tracker.capture([target, label], url, 0, perceived);
      tracker.executed(click, frame, "node", 0);
      expect(tracker.observe(frame)).toBe("insufficient-evidence");
    }
    const unscoped = new ActionOutcomeTracker({});
    const frame = unscoped.capture([target, label], url, 0, [target, label, extra]);
    unscoped.executed(click, frame, "node", 0);
    expect(unscoped.observe(frame)).toBe("insufficient-evidence");
  });

  it("tracks the old target independently while attributing the next executed action", () => {
    const tracker = new ActionOutcomeTracker({ maxRepeats: 1, scope: rows => rows.filter(r => r.role === "heading") });
    const other = { role: "button", name: "Other" }, before = tracker.capture([target, label, other], url, 0);
    tracker.executed(click, before, "a", 0);
    tracker.observe(before);
    tracker.executed({ kind: "click", target: { role: other.role, text: other.name } }, before, "b", 1);
    expect(tracker.observe(tracker.capture([{ ...target, checked: true }, label, other], url, 0))).toBe("no-observed-change");
    expect(tracker.suspect).toBe(false);
  });

  it("bounds comparable recovery clicks on other nodes without resetting the recovery budget", () => {
    const tracker = new ActionOutcomeTracker({ maxRepeats: 2, recoveryTurns: 4 });
    const rows = [target, label, { role: "button", name: "Other" }];
    const frame = tracker.capture(rows, url, 0);
    function act(index: number) {
      const e = rows[index]!;
      tracker.executed({ kind: "click", target: { role: e.role, text: e.name } }, frame, e.name, index);
      tracker.observe(frame);
    }
    act(0); act(0);
    for (const index of [1, 2, 1]) { tracker.admitDecision(); act(index); }
    expect(tracker.halt).toBe(false);
    const driver = { armActionOutcomeIdentity(cb: (id: string) => void) { cb(label.name); },
      takeActionOutcomeIdentity: () => label.name } as unknown as Driver;
    tracker.admitDecision();
    expect(() => tracker.arm(driver, { action: "click" }, () => {})).toThrow("repeated click");
    expect(tracker.halt).toBe(true);
  });

  it.each([
    [undefined, 0, url, 0], [url, 0, undefined, 0], [url, 0, "https://new.test", 0], [url, 0, url, 1],
  ] as const)("does not use stale rows across a pre-input watermark change", (entryUrl, entryRequests, dispatchUrl, dispatchRequests) => {
    const tracker = new ActionOutcomeTracker({ maxRepeats: 1 });
    const before = tracker.atDispatch(tracker.capture([target], entryUrl, entryRequests), dispatchUrl, dispatchRequests);
    tracker.executed(click, before, "node", 0);
    expect(tracker.observe(tracker.capture([{ ...target, checked: true }], dispatchUrl, dispatchRequests))).toBe("insufficient-evidence");
  });

  it("does not count earlier background traffic again on a later veto", () => {
    const tracker = new ActionOutcomeTracker({ maxRepeats: 1 });
    const before = tracker.capture([target, label], url, 0), after = tracker.capture([target, label], url, 1);
    tracker.executed(click, before, "a", 0);
    tracker.observe(before);
    tracker.executed({ kind: "click", target: { role: label.role, text: label.name } }, tracker.atDispatch(before, url, 1), "b", 1);
    expect(tracker.observe(after)).toBe("insufficient-evidence");
    tracker.observe(after);
    expect(tracker.suspect).toBe(true);
  });

  it("keeps the blocked page's known URL across a missing watermark until a different page is observed", () => {
    const tracker = new ActionOutcomeTracker({ maxRepeats: 1 });
    const old = tracker.capture([target, label], url, 0);
    tracker.executed(click, old, "a", 0);
    expect(tracker.observe(old)).toBe("no-observed-change");
    tracker.executed({ kind: "click", target: { role: label.role, text: label.name } },
      tracker.atDispatch(old, undefined, 0), "b", 1);
    expect(tracker.observe(tracker.capture([target, label], undefined, 0))).toBe("insufficient-evidence");
    expect(tracker.suspect).toBe(true);
    tracker.observe(tracker.capture([target, label], url + "/complete", 0));
    expect(tracker.suspect).toBe(false);
  });

  it("still observes a later change to the original target when a newer request watermark invalidated B's listing", () => {
    const tracker = new ActionOutcomeTracker({ maxRepeats: 1, scope: rows => rows.filter(r => r.role === "heading") });
    const before = tracker.capture([target, label], url, 0);
    tracker.executed(click, before, "a", 0);
    tracker.observe(before);
    tracker.executed({ kind: "click", target: { role: label.role, text: label.name } }, tracker.atDispatch(before, url, 1), "b", 1);
    expect(tracker.observe(tracker.capture([{ ...target, checked: true }, label], url, 1))).toBe("insufficient-evidence");
    expect(tracker.suspect).toBe(false);
  });

  it.each(["checkbox", "switch", "radio", "menuitemcheckbox", "menuitemradio", "option", "tab"])(
    "requires a measured checked or selected state from a %s target", role => {
      const control = { role, name: "Choice" }, action = { kind: "click", target: { role, text: control.name } } as const;
      const tracker = new ActionOutcomeTracker({ maxRepeats: 1 });
      const raw = [control, label];
      const before = tracker.capture(raw, url, 0);
      tracker.executed(action, before, "node", 0);
      expect(tracker.observe(before)).toBe("insufficient-evidence");
      const known = role === "option" || role === "tab" ? { ...control, selected: false } : { ...control, checked: false };
      const corrected = tracker.capture(raw, url, 0, [known, label]);
      tracker.executed(action, corrected, "node", 1);
      expect(tracker.observe(corrected)).toBe("no-observed-change");
      // Positive independent evidence still wins when the target cannot be measured.
      tracker.executed(action, before, "node", 2);
      expect(tracker.observe(tracker.capture([control, { ...label, name: "Details" }], url, 0))).toBe("observed-change");
    });

  it.each(["textbox", "searchbox", "spinbutton", "slider", "combobox", "scrollbar", "progressbar", "meter"])(
    "distinguishes a missing %s value from a measured empty value", role => {
      const input = { role, name: "Field" }, action = { kind: "click", target: { role, text: input.name } } as const;
      const tracker = new ActionOutcomeTracker({ maxRepeats: 1 });
      const missing = tracker.capture([input], url, 0);
      tracker.executed(action, missing, "node", 0);
      expect(tracker.observe(missing)).toBe("insufficient-evidence");
      expect(tracker.suspect).toBe(false);
      const known = tracker.capture([input], url, 0, [{ ...input, value: "" }]);
      tracker.executed(action, known, "node", 1);
      expect(tracker.observe(known)).toBe("no-observed-change");
    });

  it("requires measured states from declared prerequisites without treating every control on the page as required", () => {
    const input = { role: "textbox", name: "Email" }, button = { role: "button", name: "Save" };
    const action = { kind: "click", target: { role: button.role, text: button.name } } as const;
    const scoped = new ActionOutcomeTracker({ maxRepeats: 1, scope: rows => rows.filter(r => r.role !== "button") });
    const rows = [button, input, label], missing = scoped.capture(rows, url, 0);
    scoped.executed(action, missing, "node", 0);
    expect(scoped.observe(missing)).toBe("insufficient-evidence");
    expect(scoped.suspect).toBe(false);
    scoped.executed(action, missing, "node", 1);
    expect(scoped.observe(scoped.capture([button, input, { ...label, name: "Saved" }], url, 0))).toBe("observed-change");
    const known = scoped.capture(rows, url, 0, [button, { ...input, value: "" }, label]);
    scoped.executed(action, known, "node", 2);
    expect(scoped.observe(known)).toBe("no-observed-change");
    const unscoped = new ActionOutcomeTracker({ maxRepeats: 1 }), baseline = unscoped.capture(rows, url, 0);
    unscoped.executed(action, baseline, "node", 0);
    expect(unscoped.observe(baseline)).toBe("no-observed-change");
  });

  it("does not interpret the host's subset return order as a page change", () => {
    let reversed = false;
    const tracker = new ActionOutcomeTracker({ scope: rows => (reversed = !reversed) ? [...rows].reverse() : rows });
    tracker.executed(click, tracker.capture([target, label], url, 0), "node", 0);
    expect(tracker.observe(tracker.capture([target, label], url, 0))).toBe("no-observed-change");
  });

  it("bounds raw and host state together after JSON escaping", () => {
    const tracker = new ActionOutcomeTracker({});
    const state = { ...target, value: "\u0001".repeat(3000) };
    const raw = tracker.capture([state], url, 1);
    tracker.executed(click, raw, "node", 0);
    expect(tracker.observe(raw)).toBe("no-observed-change");
    const tooLarge = tracker.capture([state], url, 1, [{ ...state, checked: true }]);
    tracker.executed(click, tooLarge, "node", 1);
    expect(tracker.observe(tooLarge)).toBe("insufficient-evidence");
  });
});
