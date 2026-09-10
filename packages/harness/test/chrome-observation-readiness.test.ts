// file: packages/harness/test/chrome-observation-readiness.test.ts
import { beforeEach, expect, test, vi } from "vitest";
import { ChromeDevToolsDriver } from "../src/adapters/drivers/chrome.js";

const readinessWire = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; arguments: Record<string, unknown> }>,
  events: [] as string[],
  ready: false,
  guarded: false,
  insertedAfterGuard: false,
  clicked: undefined as unknown,
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class { async close() {} },
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect() {}
    async close() {}
    async listTools() {
      return { tools: [{ name: "evaluate_script", inputSchema: { type: "object", properties: { waitForStableDom: { type: "boolean" } } } }] };
    }
    async callTool(request: { name: string; arguments: Record<string, unknown> }) {
      readinessWire.calls.push(request);
      const args = request.arguments;
      let text = "";
      if (request.name === "take_snapshot") {
        readinessWire.events.push(readinessWire.ready ? "capture:ready" : "capture:loading");
        text = readinessWire.ready ? 'uid=1_1 button "Save"\nuid=1_2 button "Save"' : 'uid=1_0 StaticText "Loading…"';
      }
      if (request.name === "list_pages") text = "0: https://example.test/delayed-form [selected]";
      if (request.name === "click") readinessWire.clicked = args.uid;
      if (request.name === "evaluate_script") {
        const script = String(args.function);
        if (script.includes("new MutationObserver")) {
          readinessWire.events.push(readinessWire.ready ? "guard:ready" : "guard:loading");
          readinessWire.guarded = true;
          text = "{}";
        } else if (script.includes("const connected =")) {
          text = JSON.stringify({ connected: !readinessWire.insertedAfterGuard, revision: 0 });
        } else if (script.includes("const ids =")) {
          text = JSON.stringify(Object.fromEntries((args.args as string[]).map(uid => [uid, { referenceReady: true }])));
        } else {
          text = "{}";
        }
        // MCP settles after evaluating the script. Initial candidate insertion belongs
        // before observation, so a guard installed by this same call would record it.
        if (args.waitForStableDom !== false && !readinessWire.ready) {
          readinessWire.insertedAfterGuard = readinessWire.guarded;
          readinessWire.ready = true;
          readinessWire.events.push("render:save-buttons");
        }
      }
      return { content: [{ type: "text", text }] };
    }
  },
}));
beforeEach(() => {
  readinessWire.calls = [];
  readinessWire.events = [];
  readinessWire.ready = false;
  readinessWire.guarded = false;
  readinessWire.insertedAfterGuard = false;
  readinessWire.clicked = undefined;
});

test("delayedObservationKeepsActionableDuplicate: initial rendering completes before capture and the second duplicate remains usable through dispatch", async () => {
  const driver = new ChromeDevToolsDriver({ promoteClickables: false });
  try {
    const rows = await driver.snapshot({ perception: true });
    expect(rows.map(row => ({ name: row.name, role: row.role }))).toEqual([
      { name: "Save", role: "button" },
      { name: "Save", role: "button" },
    ]);
    const ref = rows[1]!.ref;
    expect(ref).toBeTypeOf("string");
    const target = await driver.locateRef(ref!);
    expect(target).toEqual({ text: "Save", role: "button", index: 1, nth: 1 });
    await driver.click(target, ref!);
    expect(readinessWire.clicked).toBe("1_2");
    expect(readinessWire.insertedAfterGuard).toBe(false);
  } finally { await driver.close(); }
});

test("readinessSettlesBeforeObservationGuard: a separate ordinary evaluation completes rendering before the fast observation guard is installed", async () => {
  const driver = new ChromeDevToolsDriver({ promoteClickables: false });
  try {
    await driver.snapshot({ perception: true });
    expect(readinessWire.events).toEqual(["render:save-buttons", "guard:ready", "capture:ready"]);
    const evaluations = readinessWire.calls.filter(call => call.name === "evaluate_script");
    expect(evaluations).toHaveLength(3);
    expect(evaluations[0]!.arguments).not.toHaveProperty("waitForStableDom");
    expect(String(evaluations[0]!.arguments.function)).not.toContain("new MutationObserver");
    expect(String(evaluations[1]!.arguments.function)).toContain("new MutationObserver");
    expect(evaluations[1]!.arguments.waitForStableDom).toBe(false);
    expect(evaluations[2]!.arguments.waitForStableDom).toBe(false);
    expect(readinessWire.calls.filter(call => call.name === "take_snapshot").map(call => call.arguments)).toEqual([{ verbose: true }]);
  } finally { await driver.close(); }
});
