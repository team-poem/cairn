import { afterEach, expect, it, vi } from "vitest";
import { ChromeDevToolsDriver } from "../../../src/adapters/drivers/chrome.js";
import { conditionMet } from "../../../src/core/steps.js";

// MCP 1.8.0's actual list format: page-local reqids, numeric/pending/error statuses.
const listing = (...rows: string[]) => `# list_network_requests response\n## Network requests\nShowing 1-${rows.length} of ${rows.length} (Page 1 of 1).\n${rows.join("\n")}`;
function browser(options?: ConstructorParameters<typeof ChromeDevToolsDriver>[0]) {
  const wire = { pages: "0: https://app/start [selected]", network: listing(), error: false };
  const client = { close: vi.fn(async () => {}), callTool: vi.fn(async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
    if (name === "list_network_requests" && wire.error) throw new Error("network collection failed");
    const text = name === "list_pages" ? wire.pages : name === "list_network_requests" ? wire.network : "";
    return { content: [{ type: "text", text }] };
  }) };
  const driver = new ChromeDevToolsDriver(options);
  // Inject the SDK transport boundary, retaining the real driver's collection and parsing.
  (driver as unknown as { client: unknown }).client = client;
  return { driver, wire, client };
}

afterEach(() => vi.useRealTimers());

it("retains evicted requests and their positions after repeated document navigations", async () => {
  const { driver, wire, client } = browser();
  wire.network = listing("reqid=1 POST https://app/api/order [200]");
  const first = await driver.observe();
  for (let i = 2; i <= 7; i++) {
    wire.network = listing(`reqid=${i} GET https://app/page-${i} [200]`);
    // No observation or expect between gotos: navigation boundaries must collect too.
    await driver.goto(`https://app/page-${i}`);
  }
  const requests = (await driver.observe()).logic.requests;
  expect(requests).toHaveLength(7);
  expect(requests.slice(0, 1)).toEqual(first.logic.requests);
  expect(requests.slice(1).every(r => r.method === "GET")).toBe(true);
  expect(client.callTool.mock.calls.filter(([r]) => r.name === "list_network_requests").every(
    ([r]) => r.arguments.includePreservedRequests === true,
  )).toBe(true);
  await driver.close();
});

it("updates pending in its original slot, deduplicates rows, and never lets an earlier request satisfy a new step", async () => {
  const { driver, wire } = browser();
  wire.network = listing("reqid=8 POST https://app/api/order [pending]");
  const before = await driver.observe();
  const watermark = before.logic.requests.length;
  wire.network = listing("reqid=8 POST https://app/api/order [200]", "reqid=8 POST https://app/api/order [200]", "reqid=9 GET https://app/done [200]");
  const condition = { requestStatus: { method: "POST", urlIncludes: "/api/order", status: 200 } };
  expect(await conditionMet(driver, condition, watermark)).toBe(false);
  expect(await conditionMet(driver, condition, 0)).toBe(true);
  expect(before.logic.requests[0]!.status).toBe(0);
  const snapshot = await driver.observe();
  snapshot.logic.requests[0]!.status = 500;
  expect((await driver.observe()).logic.requests[0]!.status).toBe(200);
  wire.network = listing("reqid=8 POST https://app/api/order [pending]", "reqid=10 POST https://app/api/order [200]");
  expect(await conditionMet(driver, condition, watermark)).toBe(true);
  expect((await driver.observe()).logic.requests).toHaveLength(3);
  await driver.close();
});

it("keeps request IDs separate across tabs without deduplicating distinct same-URL requests", async () => {
  const { driver, wire } = browser();
  wire.network = listing("reqid=1 POST https://app/api/order [500]");
  await driver.observe();
  wire.pages = "0: https://app/start\n1: https://app/popup [selected]";
  wire.network = listing("reqid=1 POST https://app/api/order [200]", "reqid=2 POST https://app/api/order [200]");
  expect((await driver.observe()).logic.requests.map(r => r.status)).toEqual([500, 200, 200]);
  wire.pages = "0: https://app/start [selected]\n1: https://app/popup";
  wire.network = listing("reqid=1 POST https://app/api/order [500]");
  expect((await driver.observe()).logic.requests.map(r => r.status)).toEqual([500, 200, 200]);
  await driver.close();
});

it("collects during settle before the preserved window evicts the response", async () => {
  const { driver, wire } = browser();
  wire.network = listing("reqid=1 POST https://app/api/order [200]");
  await driver.settle({ idleMs: 0, timeoutMs: 100, pollMs: 0 });
  wire.network = listing("reqid=20 GET https://app/later [200]");
  expect((await driver.observe()).logic.requests.map(r => r.method)).toEqual(["POST", "GET"]);
  await driver.close();
});

it("does not fabricate completion for an evicted pending request or a failed fetch", async () => {
  const { driver, wire } = browser();
  wire.network = listing("reqid=1 POST https://app/api/order [pending]", "reqid=2 GET https://app/lost [net::ERR_FAILED]");
  await driver.observe();
  wire.network = listing("reqid=30 GET https://app/done [200]");
  expect((await driver.observe()).logic.requests.map(r => r.status)).toEqual([0, 0, 200]);
  wire.error = true;
  await expect(driver.observe()).rejects.toThrow("network collection failed");
  await driver.close();
});

it("ignores configured polling for readiness while retaining its pending and failed evidence", async () => {
  vi.useFakeTimers();
  const { driver, wire } = browser({ settle: { idleMs: 200, pollMs: 50, ignoreRequests: ["/poll"] } });
  const rows = ["reqid=1 POST https://app/api/order [200]", "reqid=2 GET https://app/poll [pending]"];
  wire.network = listing(...rows);
  let done = false;
  const p = driver.settle().then(() => (done = true));
  await vi.advanceTimersByTimeAsync(100);
  rows.push("reqid=3 GET https://app/poll [net::ERR_FAILED]");
  wire.network = listing(...rows);
  await vi.advanceTimersByTimeAsync(100);
  await p;
  expect(done).toBe(true);
  expect((await driver.observe()).logic.requests).toEqual([
    { method: "POST", url: "https://app/api/order", status: 200 },
    { method: "GET", url: "https://app/poll", status: 0 },
    { method: "GET", url: "https://app/poll", status: 0 },
  ]);

  // A per-call empty list overrides the driver's ignore list, so this pending poll gates readiness.
  done = false;
  const override = driver.settle({ ignoreRequests: [], timeoutMs: 400 }).then(() => (done = true));
  await vi.advanceTimersByTimeAsync(300);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(100);
  await override;
  await driver.close();
});

it("does not gate readiness on evicted pending evidence or a current failed fetch", async () => {
  vi.useFakeTimers();
  const { driver, wire } = browser();
  wire.network = listing("reqid=1 POST https://app/api/order [pending]");
  await driver.observe();
  wire.network = listing("reqid=2 GET https://app/lost [net::ERR_FAILED]");
  let done = false;
  const p = driver.settle({ idleMs: 200, pollMs: 50, timeoutMs: 1_000 }).then(() => (done = true));
  await vi.advanceTimersByTimeAsync(200);
  await p;
  expect(done).toBe(true);
  expect((await driver.observe()).logic.requests.map(r => r.status)).toEqual([0, 0]);
  await driver.close();
});

it("restarts readiness after switching selected pages even when their request rows match", async () => {
  vi.useFakeTimers();
  const { driver, wire } = browser();
  wire.network = listing("reqid=1 GET https://app/shared [200]");
  let done = false;
  const p = driver.settle({ idleMs: 200, pollMs: 50 }).then(() => (done = true));
  await vi.advanceTimersByTimeAsync(100);
  // The URLs also match: selected page identity alone must restart the quiet window.
  wire.pages = "0: https://app/start\n1: https://app/start [selected]";
  await vi.advanceTimersByTimeAsync(100);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(150);
  await p;
  expect((await driver.observe()).logic.requests).toHaveLength(2);
  await driver.close();
});

it.each(["list_pages", "list_network_requests", "evaluate_script"])(
  "bounds a hung %s call by the settle deadline and resolves without throwing", async hungTool => {
    vi.useFakeTimers();
    const { driver, client } = browser({ timeoutMs: 30_000 });
    client.callTool.mockImplementation(async ({ name }) => {
      if (name === hungTool) return new Promise(() => {});
      return { content: [{ type: "text", text: name === "list_pages" ? "0: https://app/start [selected]" : "" }] };
    });
    let done = false;
    const p = driver.settle({ timeoutMs: 125 }).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(124);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
    await driver.close();
  },
);

it("rejects rows without page identity and conflicting reused IDs instead of mixing evidence", async () => {
  const { driver, wire } = browser();
  wire.pages = "";
  wire.network = listing("reqid=1 GET https://app/start [200]");
  await expect(driver.observe()).rejects.toMatchObject({ kind: "transport" });
  wire.pages = "0: https://app/start [selected]";
  await driver.observe();
  wire.network = listing("reqid=1 POST https://app/api/order [200]");
  await expect(driver.observe()).rejects.toMatchObject({ kind: "transport" });
  await driver.close();
});

it("new driver sessions cannot inherit the previous run's success and close is terminal", async () => {
  const first = browser();
  first.wire.network = listing("reqid=1 POST https://app/api/order [200]");
  await first.driver.observe();
  await first.driver.close();
  await expect(first.driver.observe()).rejects.toMatchObject({ kind: "transport" });
  const second = browser();
  second.wire.network = listing("reqid=1 POST https://app/api/order [500]");
  expect((await second.driver.observe()).logic.requests.map(r => r.status)).toEqual([500]);
  await second.driver.close();
});
