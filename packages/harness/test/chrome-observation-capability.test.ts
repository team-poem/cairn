// file: packages/harness/test/chrome-observation-capability.test.ts
import { beforeEach, expect, test, vi } from "vitest";
import { ChromeDevToolsDriver, type ChromeDriverOptions } from "../src/adapters/drivers/chrome.js";

const capabilityWire = vi.hoisted(() => ({
  transports: [] as Array<{ command: string; args?: string[] }>,
  calls: [] as Array<{ name: string; arguments: Record<string, unknown> }>,
  connects: 0,
  lists: 0,
  closes: 0,
  tools: undefined as unknown,
  listError: undefined as unknown,
  hangList: false,
  rejectGuard: false,
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    onclose?: () => void;
    constructor(options: { command: string; args?: string[] }) { capabilityWire.transports.push(options); }
    async close() { capabilityWire.closes++; this.onclose?.(); }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect() { capabilityWire.connects++; }
    async close() {}
    async listTools() {
      capabilityWire.lists++;
      if (capabilityWire.hangList) return new Promise<never>(() => {});
      if (capabilityWire.listError) throw capabilityWire.listError;
      return capabilityWire.tools;
    }
    async callTool(request: { name: string; arguments: Record<string, unknown> }) {
      capabilityWire.calls.push(request);
      const args = request.arguments;
      let text = "";
      if (request.name === "take_snapshot") text = 'uid=1_1 button "Save"\nuid=1_2 button "Save"';
      if (request.name === "list_pages") text = '0: https://example.test/form [selected]';
      if (request.name === "evaluate_script") {
        const script = String(args.function);
        if (script.includes("new MutationObserver") && capabilityWire.rejectGuard) {
          return { isError: true, content: [{ type: "text", text: "guard initialization rejected" }] };
        }
        if (script.includes("const connected =")) {
          text = JSON.stringify({ connected: true, revision: 0 });
        } else if (script.includes("const ids =")) {
          text = JSON.stringify(Object.fromEntries((args.args as string[]).map(uid => [uid, { referenceReady: true }])));
        } else {
          text = "{}";
        }
      }
      return { content: [{ type: "text", text }] };
    }
  },
}));
function capabilityTools(property: unknown = { type: "boolean" }): unknown {
  return { tools: [{ name: "evaluate_script", inputSchema: { type: "object", properties: { waitForStableDom: property } } }] };
}
beforeEach(() => {
  capabilityWire.transports = [];
  capabilityWire.calls = [];
  capabilityWire.connects = 0;
  capabilityWire.lists = 0;
  capabilityWire.closes = 0;
  capabilityWire.tools = capabilityTools();
  capabilityWire.listError = undefined;
  capabilityWire.hangList = false;
  capabilityWire.rejectGuard = false;
});
async function withCapabilityDriver(run: (driver: ChromeDevToolsDriver) => Promise<void>, options: ChromeDriverOptions = {}): Promise<void> {
  const driver = new ChromeDevToolsDriver({ promoteClickables: false, ...options });
  try { await run(driver); } finally { await driver.close(); }
}
async function captureAndClickSecond(driver: ChromeDevToolsDriver): Promise<void> {
  const rows = await driver.snapshot({ perception: true });
  const ref = rows[1]?.ref;
  expect(ref).toBeTypeOf("string");
  const target = await driver.locateRef(ref!);
  expect(target).toEqual({ text: "Save", role: "button", index: 1, nth: 1 });
  expect(JSON.stringify(target)).not.toContain(ref!);
  await driver.click(target, ref!);
  expect(capabilityWire.calls.filter(call => call.name === "click").at(-1)?.arguments).toEqual({ uid: "1_2" });
}
function observationEvaluations() {
  return capabilityWire.calls.filter(call => call.name === "evaluate_script");
}

test("observationServerPinAndOverride: the default uses MCP 1.8.0 with legacy page routing while custom launch settings remain exact", async () => {
  await withCapabilityDriver(driver => driver.snapshot().then(() => {}));
  expect(capabilityWire.transports[0]).toEqual({ command: "npx", args: ["-y", "chrome-devtools-mcp@1.8.0", "--isolated", "--no-page-id-routing"] });
  await withCapabilityDriver(driver => driver.snapshot().then(() => {}), { command: "custom-mcp", args: ["--custom-protocol"] });
  expect(capabilityWire.transports[1]).toEqual({ command: "custom-mcp", args: ["--custom-protocol"] });
});

test("coldObservationNegotiatesBeforeItsFirstGuard: all five observation evaluations opt out of stable-DOM waiting while keeping the selected UID and capture boundaries", async () => {
  await withCapabilityDriver(async driver => {
    await captureAndClickSecond(driver);
    expect(capabilityWire.lists).toBe(1);
    const evaluations = observationEvaluations();
    expect(evaluations).toHaveLength(5);
    for (const call of evaluations) expect(call.arguments.waitForStableDom).toBe(false);
    expect(capabilityWire.calls.filter(call => call.name === "take_snapshot").map(call => call.arguments)).toEqual([{ verbose: true }, {}]);
    // A first action may select its newly tracked tab; the thirteen observation/action calls retain their order.
    expect(capabilityWire.calls.filter(call => call.name !== "select_page").map(call => call.name)).toEqual([
      "evaluate_script", "take_snapshot", "list_pages", "evaluate_script", "list_pages", "evaluate_script",
      "take_snapshot", "list_pages", "evaluate_script", "list_pages", "evaluate_script", "click", "list_pages",
    ]);
    expect(capabilityWire.calls.find(call => call.name === "click")?.arguments).toEqual({ uid: "1_2" });
  });
});

test("observationCapabilityRequiresAnAdvertisedBoolean: absent or malformed tool schemas preserve the legacy evaluation protocol", async () => {
  for (const tools of [
    { tools: [] },
    { tools: [{ name: "evaluate_script", inputSchema: { type: "object", properties: {} } }] },
    capabilityTools({ type: "string" }),
    capabilityTools(null),
    { tools: "malformed" },
  ]) {
    capabilityWire.tools = tools;
    capabilityWire.calls = [];
    const before = capabilityWire.lists;
    await withCapabilityDriver(async driver => {
      await captureAndClickSecond(driver);
      expect(capabilityWire.lists - before).toBe(1);
      expect(observationEvaluations()).toHaveLength(5);
      for (const call of observationEvaluations()) expect(call.arguments).not.toHaveProperty("waitForStableDom");
    });
  }
});

test("observationCapabilityIsConnectionScopedAndDoesNotChangeInputs: recapture reuses negotiation while scrolling and actual clicks keep default semantics", async () => {
  await withCapabilityDriver(async driver => {
    await driver.goto("https://example.test/form");
    capabilityWire.calls = [];
    await captureAndClickSecond(driver);
    capabilityWire.tools = { tools: [] }; // no second negotiation for an established connection
    await captureAndClickSecond(driver);
    await driver.scroll("down");
    expect(capabilityWire.lists).toBe(1);
    const evaluations = observationEvaluations();
    expect(evaluations).toHaveLength(11);
    for (const call of evaluations.slice(0, 10)) expect(call.arguments.waitForStableDom).toBe(false);
    expect(String(evaluations[10]!.arguments.function)).toContain("window.scrollBy");
    expect(evaluations[10]!.arguments).not.toHaveProperty("waitForStableDom");
    expect(capabilityWire.calls.filter(call => call.name === "click").map(call => call.arguments)).toEqual([{ uid: "1_2" }, { uid: "1_2" }]);
  });
});

test("unsupportedToolDiscoveryFallsBackOnce: a non-transport introspection error keeps ordinary evaluation usable without retrying discovery", async () => {
  capabilityWire.listError = new Error("Method not found: tools/list");
  await withCapabilityDriver(async driver => {
    await captureAndClickSecond(driver);
    await driver.snapshot({ perception: true });
    expect(capabilityWire.lists).toBe(1);
    for (const call of observationEvaluations()) expect(call.arguments).not.toHaveProperty("waitForStableDom");
  });
});
