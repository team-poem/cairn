import { expect, test } from "vitest";
import { ChromeDevToolsDriver } from "../src/adapters/drivers/chrome.js";
import { captureGuidanceScope, type PageGuidanceScopeFacts } from "../src/core/guidance-scope.js";
import { stepError } from "../src/core/errors.js";

const page = "1: https://app/cart [selected]";
const scope = { target: { role: "button", name: "Checkout" }, prerequisites: [{ role: "checkbox", name: "Include" }] };
const facts: PageGuidanceScopeFacts = {
  documentId: "document", complete: true,
  targets: [{ ...scope.target, id: "button", occluded: false, disabled: false }],
  prerequisites: [{ members: [{ role: "checkbox", name: "Include", id: "input", checked: true, disabled: false }] }],
};
const raw = `uid=doc RootWebArea "Cart"
  uid=banner StaticText "Promotion "Round 4""
  uid=fresh-input checkbox "Include" checked
  uid=fresh-button button "Checkout"`;

// Start at the engine's final receipt, keep the driver's actual MCP dispatch lifecycle,
// and supply only the tool replies. DOM/AX measurement itself has a real Chrome fixture.
function fixture(options: { pages?: string; failPage?: Error; failPageAt?: number; failClick?: Error;
  clickReply?: { text: string; isError?: boolean } } = {}) {
  const driver = new ChromeDevToolsDriver();
  const ref = "cairn-guidance:test";
  const events: string[] = [];
  const client = {
    async callTool(tool: {name: string; arguments: Record<string, unknown>}) {
      const { name } = tool;
      events.push(name);
      if (name === "list_pages" && options.failPage && events.filter(e => e === name).length === (options.failPageAt ?? 1)) throw options.failPage;
      if (name === "click") {
        expect(tool.arguments.uid).toBe("fresh-button");
        if (options.failClick) throw options.failClick;
        if (options.clickReply) return { isError: options.clickReply.isError, content: [{ type: "text", text: options.clickReply.text }] };
      }
      if (name === "handle_dialog") expect(tool.arguments).toEqual({ action: "accept" });
      let text = name === "take_snapshot" ? raw : options.pages ?? page;
      if (name === "evaluate_script") {
        const uids = tool.arguments.args as string[] | undefined;
        if (String(tool.arguments.function).includes("const peerRoles =")) {
          expect(uids).toEqual(["fresh-button", "fresh-input"]);
          text = JSON.stringify(facts);
        } else {
          text = JSON.stringify(Object.fromEntries((uids ?? []).map(uid => [uid, { referenceReady: true }])));
        }
      }
      return { content: [{ type: "text", text }] };
    },
  };
  Object.assign(driver, { client, guidanceClick: { ref, version: 1, page, scope, expected: captureGuidanceScope(scope, facts) } });
  return { driver, client, events, click: (check?: () => void) => driver.click({ role:"button", text:"Checkout" }, ref, check) };
}

test("a scoped click checks cancellation after live validation and before sending any input", async () => {
  const { click, events } = fixture();
  // Dialog wording in a caller's abort reason must not trigger a browser interaction.
  const reason = new Error("cancelled before open dialog");
  await expect(click(() => { events.push("abort"); throw reason; })).rejects.toBe(reason);
  expect(events).toEqual(["list_pages", "take_snapshot", "list_pages", "evaluate_script", "abort"]);
});

test("an outcome veto on a scoped click precedes the guidance dispatch boundary", async () => {
  const { driver, click, events } = fixture();
  const veto = new Error("repeat veto");
  // The fixture supplies no node identity. Even then, final cancellation/budget admission
  // must run and a veto must not make this an unacknowledged click.
  driver.armActionOutcomeIdentity(id => {
    expect(id).toBeUndefined();
    events.push("outcome-veto");
    throw veto;
  });
  await expect(click(() => events.push("dispatch-possible"))).rejects.toBe(veto);
  expect(events.at(-1)).toBe("outcome-veto");
  expect(events).not.toContain("dispatch-possible");
  expect(events).not.toContain("click");
  expect(driver.takeActionOutcomeIdentity()).toBeUndefined();
});

test("a scoped click uses the refreshed exact UID and never resends on a lost response", async () => {
  const reason = stepError("transport", "lost input response");
  const { click, events } = fixture({ failClick: reason });
  await expect(click(() => { events.push("checked"); })).rejects.toBe(reason);
  await expect(click()).rejects.toMatchObject({ name: "ScopedGuidanceExpired" });
  expect(events).toEqual(["list_pages", "take_snapshot", "list_pages", "evaluate_script", "checked", "click"]);
});

const dialog = '# Open dialog\nconfirm: Okay?.\nCall handle_dialog to handle it before continuing.';
test.each([
  stepError("transport", "connection closed while processing open dialog"),
  Object.assign(new Error("Connection closed while processing open dialog"), { name: "AbortError" }),
  Object.assign(new Error("Connection closed while processing open dialog"), { name: "BudgetExceededError" }),
  new Error('could not click "Open dialog"'),
])("a scoped click does not handle dialog words in a rejected tool call: %s", async reason => {
  const { click, events } = fixture({ failClick: reason });
  await expect(click()).rejects.toBe(reason);
  expect(events.filter(n => n === "click" || n === "handle_dialog")).toEqual(["click"]);
});

test.each([
  ['Error: Cannot click element "Open dialog"', undefined],
  ['Error: Protocol error (Input.dispatchMouseEvent): Target closed on "Open dialog"', "transport"],
  [dialog + '\nError: Protocol error (Input.dispatchMouseEvent): Target closed', "transport"],
  [dialog + '\nError: Failed to interact with the element with uid fresh-button. The element did not become interactive within the configured timeout.', undefined],
  [dialog + '\nError: A dialog is open (confirm: Okay?).', undefined],
  ['# Open dialog\nalert: Could not find Chrome.\nCall handle_dialog to handle it before continuing.\nError: A dialog is open (alert: Could not find Chrome).', undefined],
] as const)("an MCP error never confirms a scoped click: %s", async (text, kind) => {
  const { click, events } = fixture({ clickReply: { text, isError: true } });
  const error = await click().then(() => undefined, (err: Error & { kind?: string }) => err);
  expect(error?.message).toBe("MCP click failed: " + text);
  expect(error?.kind).toBe(kind);
  expect(events.filter(n => n === "click" || n === "handle_dialog")).toEqual(["click"]);
});

test("an acknowledged scoped click with an open dialog accepts it once", async () => {
  const { click, events } = fixture({ clickReply: { text: "Successfully clicked on the element\n" + dialog } });
  await click();
  expect(events.filter(n => n === "click" || n === "handle_dialog")).toEqual(["click", "handle_dialog"]);
});

test("arming outcomes never relaxes scoped guidance's rejected-click dialog policy", async () => {
  const text = "# Open dialog\nalert: Done.\nCall handle_dialog to handle it before continuing.\nError: Failed to interact with the element with uid fresh-button. The element did not become interactive within the configured timeout.";
  const { driver, click, events } = fixture({ clickReply: { text, isError:true } });
  driver.armActionOutcomeIdentity();
  driver.armActionOutcomeDispatch(() => {});
  await expect(click()).rejects.toThrow(/Failed to interact/);
  expect(events.filter(n => n === "click" || n === "handle_dialog")).toEqual(["click"]);
  expect(driver.takeActionOutcomeIdentity()).toBeUndefined();
});

test.each(["2: https://app/cart [selected]", "1: https://app/new [selected]", "unavailable"])(
  "scoped input refuses a changed or unknown page (%s)", async pages => {
    const { click, events } = fixture({ pages });
    await expect(click()).rejects.toMatchObject({ name: "ScopedGuidanceExpired" });
    expect(events).toEqual(["list_pages"]);
  });

test.each([1, 2])("a transport error at scoped dispatch page read %i preserves its cause and sends no input", async failPageAt => {
  const reason = stepError("transport", "page session lost");
  const { click, events } = fixture({ failPage: reason, failPageAt });
  await expect(click(() => { events.push("before-send"); })).rejects.toBe(reason);
  expect(events.filter(name => name === "list_pages")).toHaveLength(failPageAt);
  expect(events).not.toContain("before-send");
  expect(events).not.toContain("click");
});

test.each([1, 2])("scoped capture preserves transport errors at page read %i rather than returning an incomplete observation", async failPageAt => {
  const reason = stepError("transport", "page session lost");
  const { driver, events } = fixture({ failPage: reason, failPageAt });
  await expect(driver.snapshotWithGuidanceScope(scope)).rejects.toBe(reason);
  expect(events.filter(name => name === "list_pages")).toHaveLength(failPageAt);
  expect(events).not.toContain("click");
});

test("a receipt invalidated between validation and send expires without entering the dispatch boundary", async () => {
  const { driver, client, click, events } = fixture();
  Object.assign(driver, { async ensureConnected() {
    if (events.at(-1) === "evaluate_script") Object.assign(driver, { guidanceClick: undefined });
    return client;
  } });
  await expect(click(() => { events.push("before-send"); })).rejects.toMatchObject({ name: "ScopedGuidanceExpired" });
  expect(events).toContain("evaluate_script");
  expect(events).not.toContain("before-send");
  expect(events).not.toContain("click");
});

test("an ownership change before input expires the scoped decision without leaking a handler error", async () => {
  const { driver, click, events } = fixture();
  Object.assign(driver, { hostRoots: { assertStamp: () => { throw stepError("handler", "Host ownership changed"); } } });
  await expect(click()).rejects.toMatchObject({ name: "ScopedGuidanceExpired", diagnostic: { scopeStatus: "scope-unverifiable" } });
  expect(events).toEqual(["list_pages"]);
});
