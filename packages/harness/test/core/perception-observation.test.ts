import { describe, it, expect } from "vitest";
import { rankElements } from "../../src/core/perception.js";
import { PerceptionObservation } from "../../src/core/observation.js";
import { applyDecision } from "../../src/core/discover/decision.js";
import { StubDriver } from "../support/doubles.js";
import type { PageElement, Target } from "../../src/core/types.js";

class RefDriver extends StubDriver {
  dispatched: string[] = [];
  async locateRef(ref: string): Promise<Target> { return { text: "Remove", role: "button", nth: ref === "node-b" ? 1 : 0, selector: `#${ref}` }; }
  override async click(_target: Target, ref?: string) { this.dispatched.push(ref ?? "legacy"); }
}
const rows: PageElement[] = [
  { role: "button", name: "Remove", ref: "node-a" },
  { role: "button", name: "Remove", ref: "node-b" },
];
function token(table: string, nth = 1) { return table.split("\n").find(l => l.includes(`nth=${nth}`))!.match(/ref="([^"]+)"/)![1]!; }

describe("shared perception facts", () => {
  it("retains trailing popup options ahead of 80 background controls and respects hard caps", () => {
    const all = [...Array.from({ length: 80 }, (_, i) => ({ role: "button", name: `Background ${i}` })), { role: "option", name: "Choice", inActivePopup: true }];
    expect(rankElements(all, "choose", 60)[0]?.name).toBe("Choice");
    for (const cap of [0, 1, 60]) expect(rankElements(all, "choose", cap)).toHaveLength(cap);
    expect(all[80]?.role).toBe("option");
  });
  it("positive occlusion consumes neither clickable region nor 40-region quota", () => {
    const all: PageElement[] = [...Array.from({ length: 40 }, (_, i) => ({ role: "StaticText", name: `Covered ${i}`, clickable: true, clickableRegion: `${i}`, occluded: true })), { role: "StaticText", name: "Visible", clickable: true, clickableRegion: "0" }, { role: "StaticText", name: "Sibling", clickable: true, clickableRegion: "0" }];
    expect(rankElements(all, "", 60).map(e => e.name)).toEqual(["Visible"]);
  });
});

describe("observation bindings", () => {
  it("binds exact duplicate before policy and freezes only persistent locators", async () => {
    const driver = new RefDriver();
    const view = new PerceptionObservation(driver, rows, rows, "remove");
    const decision = view.bind({ action: "click", ref: token(view.references) });
    expect(decision).toMatchObject({ text: "Remove", role: "button", nth: 1 });
    const step = await applyDecision(driver, decision);
    expect(driver.dispatched).toEqual(["node-b"]);
    expect(step).toEqual({ kind: "click", target: { text: "Remove", role: "button", nth: 1, selector: "#node-b" } });
    await expect(applyDecision(driver, decision)).rejects.toThrow(/consumed|expired/);
  });
  it("rejects forged, contradictory and superseded refs without legacy fallback", async () => {
    const driver = new RefDriver();
    const view = new PerceptionObservation(driver, rows, rows, "remove");
    expect(() => view.bind({ action: "click", ref: "forged" })).toThrow();
    const next = new PerceptionObservation(driver, rows, rows, "remove");
    expect(() => next.bind({ action: "click", ref: token(next.references), text: "Safe" })).toThrow();
    const current = new PerceptionObservation(driver, rows, rows, "remove");
    const decision = current.bind({ action: "click", ref: token(current.references) });
    new PerceptionObservation(driver, rows, rows, "remove");
    await expect(applyDecision(driver, decision)).rejects.toThrow(/expired/);
    await expect(applyDecision(driver, { action: "click", ref: "node-b", text: "Remove" })).rejects.toThrow();
    expect(driver.dispatched).toEqual([]);
  });
  it("keeps semantic content stable and supplies fresh engine refs", () => {
    const driver = new RefDriver();
    const a = new PerceptionObservation(driver, rows, rows, "remove");
    const rotated = rows.map(e => ({ ...e, ref: `${e.ref}-new` }));
    const b = new PerceptionObservation(driver, rotated, rotated, "remove");
    expect(a.render).toBe(b.render);
    expect(a.references).not.toBe(b.references);
    expect(a.references).not.toContain("node-b");
    const changed = rows.map(e => ({ ...e, checked: true }));
    expect(new PerceptionObservation(driver, changed, changed, "remove").render).not.toBe(a.render);
  });
  it("preserves full snapshot nth through reorder and refuses redirected or duplicate bindings", () => {
    const driver = new RefDriver();
    const corrected = [{ ...rows[1]!, checked: true }];
    const view = new PerceptionObservation(driver, rows, corrected, "remove");
    expect(view.render).toContain("(nth=1)");
    expect(view.bind({ action: "click", ref: token(view.references) }).nth).toBe(1);
    expect(() => new PerceptionObservation(driver, rows, [{ ...rows[0]!, name: "Safe" }], "")).toThrow();
    expect(() => new PerceptionObservation(driver, rows, [rows[0]!, rows[0]!], "")).toThrow();
  });
});

it("popup membership outranks background even when the intent contains many matching words", () => {
  const intent = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
  const popup: PageElement = { role: "option", name: "Popup", inActivePopup: true };
  expect(rankElements([{ role: "button", name: intent }, popup], intent, 1)).toEqual([popup]);
});

it("ref actions refuse missing persistent targets and failed exact dispatch without fallback", async () => {
  class Unlocatable extends RefDriver { override async locateRef(): Promise<Target> { return {}; } }
  const driver = new Unlocatable();
  const page = new PerceptionObservation(driver, rows, rows, "remove");
  await expect(applyDecision(driver, page.bind({ action: "click", ref: token(page.references) }))).rejects.toThrow(/persistent target/);
  expect(driver.dispatched).toEqual([]);
  class Detached extends RefDriver { override async click(): Promise<void> { throw new Error("node detached"); } }
  const detached = new Detached();
  const view = new PerceptionObservation(detached, rows, rows, "remove");
  await expect(applyDecision(detached, view.bind({ action: "click", ref: token(view.references) }))).rejects.toThrow(/detached/);
  expect(detached.dispatched).toEqual([]);
});

it("reference dispatch keeps scoped secrets behind the shared type handler", async () => {
  class InputDriver extends RefDriver {
    filled: { value: string; ref?: string }[] = [];
    override async type(_target?: Target, value = "", ref?: string) { this.filled.push({ value, ref }); }
  }
  const driver = new InputDriver();
  const page = new PerceptionObservation(driver, rows, rows, "fill");
  const decision = page.bind({ action: "type", ref: token(page.references), value: "{password}" });
  const step = await applyDecision(driver, decision, { password: { value: "secret-value", origin: "https://app" } });
  expect(driver.filled).toEqual([{ value: "secret-value", ref: "node-b" }]);
  expect(step).toMatchObject({ text: "{password}" });
});

it("reserves intent evidence under the hard cap even when more than 60 popup options exist", () => {
  const all: PageElement[] = [...Array.from({ length: 80 }, (_, i) => ({ role: "option", name: `Option ${i}`, inActivePopup: true })), { role: "StaticText", name: "Saved successfully" }];
  const before = JSON.stringify(all);
  for (const cap of [0, 1, 60]) {
    const ranked = rankElements(all, "saved", cap);
    expect(ranked).toHaveLength(cap);
    if (cap > 0) expect(ranked).toContain(all[80]);
  }
  expect(rankElements(all, "saved", 60).filter(e => e.role === "option").at(-1)?.name).toBe("Option 58");
  expect(JSON.stringify(all)).toBe(before);
});

it("shows measured clickable and popup states without claiming an ARIA button role", () => {
  const driver = new RefDriver();
  const facts: PageElement[] = [{ role: "StaticText", name: "Open", clickable: true, inActivePopup: true }];
  const page = new PerceptionObservation(driver, facts, facts, "open");
  expect(page.render).toContain("[StaticText] Open (clickable, active popup)");
});
