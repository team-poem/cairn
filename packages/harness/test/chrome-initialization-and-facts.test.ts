// file: packages/harness/test/chrome-initialization-and-facts.test.ts
import { beforeEach, expect, test, vi } from "vitest";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ChromeDevToolsDriver, type ChromeDriverOptions } from "../src/adapters/drivers/chrome.js";

const issue231Wire = vi.hoisted(() => ({
  transports: [] as Array<{ onclose?: () => void; closes: number }>,
  calls: [] as Array<{ name: string; arguments: Record<string, unknown> }>,
  connects: 0,
  lists: 0,
  connectGate: undefined as Promise<void> | undefined,
  listGate: undefined as Promise<void> | undefined,
  connectError: undefined as unknown,
  listError: undefined as unknown,
  factError: undefined as unknown,
  factEnvelope: undefined as string | undefined,
  badUid: undefined as string | undefined,
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    onclose?: () => void;
    closes = 0;
    constructor() { issue231Wire.transports.push(this); }
    async close() { this.closes++; this.onclose?.(); }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect() {
      issue231Wire.connects++;
      await issue231Wire.connectGate;
      if (issue231Wire.connectError) throw issue231Wire.connectError;
    }
    async close() {}
    async listTools() {
      issue231Wire.lists++;
      await issue231Wire.listGate;
      if (issue231Wire.listError) throw issue231Wire.listError;
      return { tools: [{ name: "evaluate_script", inputSchema: { type: "object", properties: { waitForStableDom: { type: "boolean" } } } }] };
    }
    async callTool(request: { name: string; arguments: Record<string, unknown> }) {
      issue231Wire.calls.push(request);
      let text = "";
      if (request.name === "list_pages") text = "0: https://example.test/form [selected]";
      if (request.name === "take_snapshot") text = Array.from({ length: 8 }, (_, i) => `uid=1_${i + 1} button "Save ${i + 1}"`).join("\n");
      if (request.name === "evaluate_script") {
        if (String(request.arguments.function).includes("const ids =")) {
          const ids = request.arguments.args as string[];
          if (issue231Wire.factError) throw issue231Wire.factError;
          if (issue231Wire.factEnvelope) return { isError: true, content: [{ type: "text", text: issue231Wire.factEnvelope }] };
          if (issue231Wire.badUid && ids.includes(issue231Wire.badUid)) throw new Error("Elements from different frames can't be evaluated together.");
          text = JSON.stringify(Object.fromEntries(ids.map(uid => [uid, { referenceReady: true, inActivePopup: true, clickable: true, clickableRegion: "region" }])));
        } else text = "{}";
      }
      return { content: [{ type: "text", text }] };
    }
  },
}));
beforeEach(() => {
  issue231Wire.transports = [];
  issue231Wire.calls = [];
  issue231Wire.connects = issue231Wire.lists = 0;
  issue231Wire.connectGate = issue231Wire.listGate = undefined;
  issue231Wire.connectError = issue231Wire.listError = issue231Wire.factError = undefined;
  issue231Wire.factEnvelope = issue231Wire.badUid = undefined;
});
function issue231Deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function issue231Driver(run: (driver: ChromeDevToolsDriver) => Promise<void>, options: ChromeDriverOptions = {}) {
  const driver = new ChromeDevToolsDriver(options);
  try { await run(driver); } finally { await driver.close(); }
}
function issue231FactCalls() {
  return issue231Wire.calls.filter(call => call.name === "evaluate_script" && String(call.arguments.function).includes("const ids ="));
}

test("coldObserveSharesOneConnection: API evidence collection initializes one transport and negotiates once", async () => {
  await issue231Driver(async driver => {
    const evidence = await driver.observe();
    expect(evidence.execution.finalUrl).toBe("https://example.test/form");
    expect(issue231Wire.connects).toBe(1);
    expect(issue231Wire.lists).toBe(1);
    expect(issue231Wire.transports).toHaveLength(1);
  });
  expect(issue231Wire.transports.every(transport => transport.closes === 1)).toBe(true);
});

test("pendingConnectionIsShared: concurrent calls cannot start another transport while connect is pending", async () => {
  const gate = issue231Deferred();
  issue231Wire.connectGate = gate.promise;
  await issue231Driver(async driver => {
    const first = driver.snapshot();
    const second = driver.observe();
    const connects = issue231Wire.connects;
    const calls = issue231Wire.calls.length;
    gate.resolve();
    await Promise.all([first, second]);
    expect(connects).toBe(1);
    expect(calls).toBe(0);
    expect(issue231Wire.lists).toBe(1);
  });
});

test("pendingNegotiationIsShared: tool dispatch waits for the single capability negotiation", async () => {
  const gate = issue231Deferred();
  issue231Wire.listGate = gate.promise;
  await issue231Driver(async driver => {
    const first = driver.snapshot({ perception: true });
    await vi.waitFor(() => expect(issue231Wire.lists).toBeGreaterThan(0));
    const second = driver.observe();
    const connects = issue231Wire.connects;
    const calls = issue231Wire.calls.length;
    gate.resolve();
    await Promise.all([first, second]);
    expect(connects).toBe(1);
    expect(calls).toBe(0);
    expect(issue231Wire.lists).toBe(1);
    expect(issue231FactCalls()[0]!.arguments.waitForStableDom).toBe(false);
  });
});
