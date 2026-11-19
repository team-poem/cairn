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
function fixture(options: { pages?: string; failPage?: Error; failClick?: Error } = {}) {
  const driver = new ChromeDevToolsDriver();
  const ref = "cairn-guidance:test";
  const events: string[] = [];
  const client = {
    async callTool(tool: {name: string; arguments: Record<string, unknown>}) {
      const { name } = tool;
      events.push(name);
      if (name === "list_pages" && options.failPage) throw options.failPage;
      if (name === "click") {
        expect(tool.arguments.uid).toBe("fresh-button");
        if (options.failClick) throw options.failClick;
      }
      if (name === "evaluate_script") expect(tool.arguments.args).toEqual(["fresh-button", "fresh-input"]);
      const text = name === "take_snapshot" ? raw : name === "evaluate_script" ? JSON.stringify(facts) : options.pages ?? page;
      return { content: [{ type: "text", text }] };
    },
  };
  Object.assign(driver, { client, guidanceClick: { ref, version: 1, page, scope, expected: captureGuidanceScope(scope, facts) } });
  return { driver, events, click: (check?: () => void) => driver.click({ role:"button", text:"Checkout" }, ref, check) };
}

test("a scoped click checks cancellation after live validation and before sending any input", async () => {
  const { click, events } = fixture();
  // Dialog wording in a caller's abort reason must not trigger a browser interaction.
  const reason = new Error("cancelled before open dialog");
  await expect(click(() => { events.push("abort"); throw reason; })).rejects.toBe(reason);
  expect(events).toEqual(["list_pages", "take_snapshot", "list_pages", "evaluate_script", "abort"]);
});

test("a scoped click uses the refreshed exact UID and never resends on a lost response", async () => {
  const reason = stepError("transport", "lost input response");
  const { click, events } = fixture({ failClick: reason });
  await expect(click(() => { events.push("checked"); })).rejects.toBe(reason);
  await expect(click()).rejects.toMatchObject({ name: "ScopedGuidanceExpired" });
  expect(events).toEqual(["list_pages", "take_snapshot", "list_pages", "evaluate_script", "checked", "click"]);
});

test.each(["2: https://app/cart [selected]", "1: https://app/new [selected]", "unavailable"])(
  "scoped input refuses a changed or unknown page (%s)", async pages => {
    const { click, events } = fixture({ pages });
    await expect(click()).rejects.toMatchObject({ name: "ScopedGuidanceExpired" });
    expect(events).toEqual(["list_pages"]);
  });

test("a failed scoped page read preserves a typed transport error", async () => {
  const reason = stepError("transport", "page session lost");
  const { click, events } = fixture({ failPage: reason });
  await expect(click()).rejects.toBe(reason);
  expect(events).toEqual(["list_pages"]);
});

test("an ownership change before input expires the scoped decision without leaking a handler error", async () => {
  const { driver, click, events } = fixture();
  Object.assign(driver, { hostRoots: { assertStamp: () => { throw stepError("handler", "Host ownership changed"); } } });
  await expect(click()).rejects.toMatchObject({ name: "ScopedGuidanceExpired", diagnostic: { scopeStatus: "scope-unverifiable" } });
  expect(events).toEqual(["list_pages"]);
});
