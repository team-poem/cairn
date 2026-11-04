import { expect, test } from "vitest";
import { ChromeDevToolsDriver } from "../src/adapters/drivers/chrome.js";
import { CollectionSelectionError, SelectionNotDispatchedError } from "../src/core/collection.js";

const key = { kind: "attribute", scope: "item", attribute: "data-resource-id" } as const;
const stale = () => new CollectionSelectionError("stale", "fixture observation changed");

function setup(options: { phase?: "lookup" | "prepare" | "validate" | "click" | "dialog" | "finish";
  error?: Error; ready?: boolean; pageKnown?: boolean; positional?: boolean } = {}) {
  const driver = new ChromeDevToolsDriver();
  const events: string[] = [];
  const error = options.error ?? stale();
  const receipt = { ready: options.ready !== false,
    async finish() { events.push("finish"); if (options.phase === "finish") throw error;
      return options.ready === false ? { complete: false } : { complete: true, value: "B" }; },
    async dispose() { events.push("dispose"); },
  };
  const collection = {
    ...(options.positional ? {} : { choice: { identity: key } }),
    async validate() { events.push("validate"); if (options.phase === "validate") throw error; },
    async prepareSelectedItemKey() { events.push("prepare"); if (options.phase === "prepare") throw error; return receipt; },
  };
  const inner = driver as unknown as { collectionObservations: Map<string, unknown>; actionUid: () => Promise<string>;
    call: (name: string) => Promise<string>; collectNetwork: () => Promise<void> };
  inner.collectionObservations.set("ref", collection);
  inner.actionUid = async () => { events.push("lookup"); if (options.phase === "lookup") throw error; return "uid"; };
  inner.collectNetwork = async () => {};
  inner.call = async name => {
    events.push(name);
    if (name === "list_pages") return options.pageKnown === false ? "unknown" : "1: https://fixture.test [selected]";
    if (name === "click" && options.phase === "dialog") throw new Error("# Open dialog\nconfirm: continue?\nCall handle_dialog to continue.");
    if ((name === "click" && options.phase === "click") || (name === "handle_dialog" && options.phase === "dialog")) throw error;
    return "";
  };
  return { events, run: () => driver.clickWithSelectedItemEvidence({ role: "button", text: "Add" }, "ref", key) };
}

test.each(["lookup", "prepare", "validate"] as const)("known stale %s failures carry a pre-dispatch marker for the exact ref", async phase => {
  const f = setup({ phase });
  await expect(f.run()).rejects.toBeInstanceOf(SelectionNotDispatchedError);
  expect(f.events).not.toContain("click");
});

test("an unavailable source receipt prevents choice dispatch", async () => {
  const f = setup({ ready: false });
  await expect(f.run()).rejects.toMatchObject({ ref: "ref", code: "stale" });
  expect(f.events).not.toContain("click");
  expect(f.events).toContain("dispose");
});

test.each(["lookup", "prepare", "validate"] as const)("a transport failure during %s is never converted into permission to reselect", async phase => {
  const error = new Error("transport unavailable"), f = setup({ phase, error });
  await expect(f.run()).rejects.toBe(error);
  expect(f.events).not.toContain("click");
});

test.each(["click", "dialog"] as const)("an uncertain %s cannot issue a pre-dispatch retry marker even for a typed stale error", async phase => {
  const error = stale(), f = setup({ phase, error });
  await expect(f.run()).rejects.toBe(error);
  expect(f.events.filter(event => event === "click")).toHaveLength(1);
  expect(f.events).toContain("dispose");
});

test("a post-click receipt failure is incomplete evidence, not retry permission", async () => {
  const f = setup({ phase: "finish" });
  expect(await f.run()).toEqual({ complete: false });
  expect(f.events.filter(event => event === "click")).toHaveLength(1);
  expect(f.events).toContain("dispose");
});

test("unknown source page identity prevents a choice mutation", async () => {
  const f = setup({ pageKnown: false });
  await expect(f.run()).rejects.toMatchObject({ code: "incomplete" });
  expect(f.events).not.toContain("click");
});

test("an ordinary positional receipt retains its previous dispatch behavior", async () => {
  const f = setup({ positional: true, ready: false });
  expect(await f.run()).toEqual({ complete: false });
  expect(f.events.filter(event => event === "click")).toHaveLength(1);
});
