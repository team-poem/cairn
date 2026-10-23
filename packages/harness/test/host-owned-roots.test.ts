import { describe, expect, test, vi } from "vitest";
import { ChromeHostRoots } from "../src/adapters/drivers/chrome-host-roots.js";
import { createHostOwnedRootScope } from "../src/adapters/drivers/host-owned-roots.js";
import { parseSnapshotRows } from "../src/adapters/drivers/chrome.js";
import { stepError } from "../src/core/errors.js";

const empty = { stamp: "document:0", active: 0, unsupported: false };
const active = { ...empty, active: 1 };
const raw = 'uid=1 button "App"\nuid=2 button "Host"';
const setup = (call: (name: string, args?: Record<string, unknown>) => Promise<string>) =>
  new ChromeHostRoots(createHostOwnedRootScope(), call, parseSnapshotRows);

describe("host ownership adapter boundary", () => {
  test("factory scopes are distinct and do not embed selector ownership", () => {
    const a = createHostOwnedRootScope(), b = createHostOwnedRootScope();
    expect(a.key).not.toBe(b.key);
    expect(Object.isFrozen(a)).toBe(true);
    expect(a.registerScript).toContain(".register(root)");
    expect(a.unregisterScript).toContain(".unregister(root)");
  });

  test("browser scope creation does not require secure-context randomUUID", () => {
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    vi.stubGlobal("crypto", { getRandomValues });
    try { expect(createHostOwnedRootScope().key).toMatch(/^cairn:host-roots:[a-f0-9-]+$/); }
    finally { vi.unstubAllGlobals(); }
  });

  test("no registrations return the byte-identical raw tree", async () => {
    const call = vi.fn(async () => JSON.stringify(empty));
    expect(await setup(call).filter(raw)).toBe(raw);
    expect(call).toHaveBeenCalledTimes(1);
  });

  test("empty scopes never evaluate ownership with a child-frame UID", async () => {
    const call = vi.fn(async () => JSON.stringify(empty));
    await setup(call).assertNode("frame:123", true, empty.stamp);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]).toEqual(["evaluate_script", expect.objectContaining({ args: [] })]);
  });

  test.each([{}, { ...active, excluded: [] }, { ...active, excluded: [false] }, { ...active, excluded: [false, 1] }])(
    "incomplete candidate measurement never returns raw content: %j", async reply => {
      const call = vi.fn().mockResolvedValueOnce(JSON.stringify(active)).mockResolvedValueOnce(JSON.stringify(reply));
      await expect(setup(call).filter(raw)).rejects.toMatchObject({ kind: "handler" });
    },
  );

  test("measurement failure is non-healable, transport failure keeps its classification", async () => {
    await expect(setup(async () => { throw new Error("node unavailable"); }).filter(raw)).rejects.toMatchObject({ kind: "handler" });
    await expect(setup(async () => { throw stepError("transport", "closed"); }).filter(raw)).rejects.toMatchObject({ kind: "transport" });
  });

  test("measurement rejects ownership change between capture and filtering", async () => {
    await expect(setup(async () => JSON.stringify(active)).filter(raw, "previous:0")).rejects.toThrow(/ownership changed/i);
  });

  test("AX frame topology also rejects a frame hidden from document.querySelector", async () => {
    await expect(setup(async () => JSON.stringify(active)).filter('uid=1 RootWebArea "App"\n  uid=2 Iframe\n    uid=3 RootWebArea "Child"'))
      .rejects.toThrow(/frame boundaries/);
  });

  test("virtual rows and ambiguous UIDs never enter ownership batches; children remain", async () => {
    const tree = 'uid=root RootWebArea "App"\n  uid=wrapper ignored\n    uid=list list\n      uid=item listitem\n' +
      '        uid=marker ListMarker "bullet"\n          uid=virtual ignored\n' +
      '        uid=text StaticText "Application item"\n          uid=virtual InlineTextBox "Application item"\n' +
      '    uid=duplicate StaticText "App generated"\n    uid=duplicate StaticText "Host generated"\n' +
      '    uid=host button "Host"';
    const call = vi.fn(async (_name: string, args?: Record<string, unknown>) => {
      const uids = args?.args as string[];
      return JSON.stringify({ ...active, excluded: uids.map(uid => uid === "host") });
    });
    const filtered = await setup(call).filter(tree);
    expect(filtered).toContain('uid=text StaticText "Application item"');
    expect(filtered).toContain('uid=item listitem');
    expect(filtered).not.toMatch(/ignored|ListMarker|InlineTextBox|generated|Host/);
    expect(call.mock.calls[1]?.[1]?.args).toEqual(["root", "text", "host"]);
  });

  test("compact generated StaticText is omitted only for its precise MCP resolution failure", async () => {
    const call = vi.fn(async (_name: string, args?: Record<string, unknown>) => {
      const uids = args?.args as string[];
      if (uids.includes("virtual")) throw new Error("MCP evaluate_script failed: Error: Element with uid virtual no longer exists on the page.");
      return JSON.stringify({ ...active, excluded: uids.map(() => false) });
    });
    expect(await setup(call).filter('uid=virtual StaticText "Generated"\nuid=button button "App"'))
      .toBe('uid=button button "App"');
    expect(call).toHaveBeenCalledTimes(4); // initial status, failure, stamp guard, measured remainder
  });

  test.each([
    ["button", "MCP evaluate_script failed: Error: Element with uid node no longer exists on the page."],
    ["StaticText", "MCP evaluate_script failed: Error: Elements from different frames can't be evaluated together."],
    ["StaticText", "MCP evaluate_script failed: Error: Host ownership node unavailable"],
    ["StaticText", "MCP evaluate_script failed: Error: Element with uid another no longer exists on the page."],
  ])("%s measurement fails closed for %s", async (role, message) => {
    const call = vi.fn().mockResolvedValueOnce(JSON.stringify(active)).mockRejectedValueOnce(new Error(message));
    await expect(setup(call).filter(`uid=node ${role} "App"`)).rejects.toMatchObject({ kind: "handler" });
    expect(call).toHaveBeenCalledTimes(2);
  });

  test("ownership changes while omitting generated text invalidate capture", async () => {
    const call = vi.fn().mockResolvedValueOnce(JSON.stringify(active))
      .mockRejectedValueOnce(new Error("MCP evaluate_script failed: Error: Element with uid node no longer exists on the page."))
      .mockResolvedValueOnce(JSON.stringify({ ...active, stamp: "changed" }));
    await expect(setup(call).filter('uid=node StaticText "Generated"')).rejects.toThrow(/ownership changed/);
  });

  test("virtual-only observations still validate the ownership stamp", async () => {
    const call = vi.fn().mockResolvedValueOnce(JSON.stringify(active))
      .mockResolvedValueOnce(JSON.stringify({ ...active, stamp: "changed", excluded: [] }));
    await expect(setup(call).filter('uid=node ListMarker "bullet"')).rejects.toThrow(/ownership changed/);
  });
});
