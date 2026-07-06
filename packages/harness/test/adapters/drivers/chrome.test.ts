import { describe, expect, it } from "vitest";
import {
  ChromeDevToolsDriver,
  findUidByName,
  followableTab,
  isOpenDialog,
  parseSnapshotRows,
  resolveTargetUid,
  isNavigation,
  normalizeUrl,
  parseConsole,
  parseElements,
  parseNetwork,
  parsePageEntries,
  parsePageIds,
  parseSelectedUrl,
  selectorProbeScript,
} from "../../../src/adapters/drivers/chrome.js";

/** Driver whose MCP layer is a scripted stub — records calls, returns canned text per tool. */
function stubbedDriver(responses: Record<string, string | ((args: Record<string, unknown>) => string)>) {
  const driver = new ChromeDevToolsDriver();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  (driver as unknown as { call: unknown }).call = async (
    name: string,
    args: Record<string, unknown> = {},
  ) => {
    calls.push({ name, args });
    const r = responses[name];
    if (r === undefined) return "";
    return typeof r === "function" ? r(args) : r;
  };
  return { driver, calls };
}

// Sample text mirrors real chrome-devtools-mcp output observed during dogfooding.

const SNAPSHOT = `uid=1_0 RootWebArea "Example Domain" url="https://example.com/"
  uid=1_1 heading "Example Domain" level="1"
  uid=1_2 StaticText "This domain is for use in documentation examples."
  uid=1_3 link "Learn more" url="https://iana.org/domains/example"
    uid=1_4 StaticText "Learn more"`;

describe("parseElements", () => {
  it("extracts role + name for named rows", () => {
    expect(parseElements(SNAPSHOT)).toEqual([
      { role: "RootWebArea", name: "Example Domain" },
      { role: "heading", name: "Example Domain" },
      { role: "StaticText", name: "This domain is for use in documentation examples." },
      { role: "link", name: "Learn more" },
      { role: "StaticText", name: "Learn more" },
    ]);
  });
});

describe("findUidByName", () => {
  it("returns the first uid whose accessible name matches (case-insensitive)", () => {
    expect(findUidByName(SNAPSHOT, "learn more")).toBe("1_3");
  });

  it("prefers an exact name over a substring match", () => {
    const snap = `uid=2_1 link "Add to Cart"\nuid=2_2 button "Cart"`;
    expect(findUidByName(snap, "Cart")).toBe("2_2"); // not 2_1 "Add to Cart"
  });

  it("never matches a bare url= attribute as a name", () => {
    const snap = `uid=3_1 link url="https://shop.com/cart"\nuid=3_2 link "Home"`;
    expect(findUidByName(snap, "shop.com/cart")).toBeUndefined();
  });
  it("returns undefined when nothing matches", () => {
    expect(findUidByName(SNAPSHOT, "checkout")).toBeUndefined();
  });
});

describe("resolveTargetUid — multi-locator", () => {
  const v1 = `uid=1_1 textbox "Username"\nuid=1_2 button "Log in"`;
  // a UI rename: same roles/positions, different visible names
  const v2 = `uid=2_1 textbox "Account"\nuid=2_2 button "Sign in"`;

  it("resolves by accessible name when it still matches", () => {
    expect(resolveTargetUid(parseSnapshotRows(v1), { text: "Log in", role: "button", index: 0 })).toBe("1_2");
  });

  it("survives a rename via role + structural index (no LLM)", () => {
    // "Log in" no longer exists on v2; role=button index=0 still finds the (renamed) login button
    expect(resolveTargetUid(parseSnapshotRows(v2), { text: "Log in", role: "button", index: 0 })).toBe("2_2");
    expect(resolveTargetUid(parseSnapshotRows(v2), { text: "Username", role: "textbox", index: 0 })).toBe("2_1");
  });

  it("returns undefined when neither name nor role+index resolves", () => {
    expect(resolveTargetUid(parseSnapshotRows(v2), { text: "Log in" })).toBeUndefined();
  });

  it("refuses an ambiguous positional fallback so a reorder can't silently mis-select (P3)", () => {
    // The frozen name is gone and several same-role candidates remain → guessing by index risks the
    // wrong one after a reorder. Yield nothing so self-heal picks by intent.
    const rows = `uid=3_1 button "Search"\nuid=3_2 button "Profile"\nuid=3_3 button "Help"`;
    expect(resolveTargetUid(parseSnapshotRows(rows), { text: "Log in", role: "button", index: 0 })).toBeUndefined();
  });

  it("still honors a deliberate positional target (role+index, no text)", () => {
    const rows = `uid=3_1 button "Search"\nuid=3_2 button "Profile"`;
    expect(resolveTargetUid(parseSnapshotRows(rows), { role: "button", index: 1 })).toBe("3_2");
  });

  it("refuses an ambiguous substring match instead of guessing the first (M1)", () => {
    // No exact "Add" — two controls contain it; picking the first would silently mis-click.
    const rows = `uid=4_1 button "Add to cart"\nuid=4_2 button "Add to wishlist"`;
    expect(resolveTargetUid(parseSnapshotRows(rows), { text: "Add" })).toBeUndefined();
    // a single substring match still resolves
    expect(resolveTargetUid(parseSnapshotRows(rows), { text: "wishlist" })).toBe("4_2");
  });
});

describe("parseNetwork", () => {
  it("parses reqid/method/url/status rows and ignores headers", () => {
    const text = `## Network requests
Showing 1-2 of 2 (Page 1 of 1).
reqid=5 GET https://www.iana.org/help/example-domains [200]
reqid=6 GET https://www.iana.org/static/iana_website.css [503]`;
    expect(parseNetwork(text)).toEqual([
      { method: "GET", url: "https://www.iana.org/help/example-domains", status: 200 },
      { method: "GET", url: "https://www.iana.org/static/iana_website.css", status: 503 },
    ]);
  });

  it("parses an in-flight [pending] row as status 0 instead of dropping it (#97)", () => {
    const text = `reqid=7 POST https://app/api/orders [pending]
reqid=8 GET https://app/api/me [200]`;
    expect(parseNetwork(text)).toEqual([
      { method: "POST", url: "https://app/api/orders", status: 0 },
      { method: "GET", url: "https://app/api/me", status: 200 },
    ]);
  });
});

describe("parseSelectedUrl", () => {
  it("reads the url of the selected page", () => {
    const text = `## Pages
1: about:blank
2: Example Domain (https://example.com/) [selected]`;
    expect(parseSelectedUrl(text)).toBe("https://example.com/");
  });
  it("handles a bare (parenthesis-less) selected entry", () => {
    expect(parseSelectedUrl(`1: about:blank [selected]`)).toBe("about:blank");
  });
  it("returns undefined when no page is selected", () => {
    expect(parseSelectedUrl(`1: about:blank`)).toBeUndefined();
  });
});

describe("isNavigation", () => {
  it("ignores a trailing-slash-only difference", () => {
    expect(isNavigation("https://example.com", "https://example.com/")).toBe(false);
  });
  it("detects a real navigation", () => {
    expect(isNavigation("https://example.com", "https://www.iana.org/help/example-domains")).toBe(true);
  });
  it("treats a first navigation (no initial url) as navigation", () => {
    expect(isNavigation(undefined, "https://example.com/")).toBe(true);
  });
  it("normalizeUrl drops trailing slash and hash", () => {
    expect(normalizeUrl("https://x.com/path/#frag")).toBe("https://x.com/path");
  });
});

describe("parsePageIds", () => {
  it("reads page ids and ignores other lines", () => {
    const text = `## Pages\n4: Example (https://example.com/) [selected]\n7: Detail (https://example.com/p/3)`;
    expect(parsePageIds(text)).toEqual([4, 7]);
  });
});

describe("parseConsole", () => {
  it("parses the real `msgid=N [type] text (M args)` format and strips the args suffix", () => {
    const text = `## Console messages
Showing 1-3 of 3 (Page 1 of 1).
msgid=1 [error] TypeError: orders is null (1 args)
msgid=2 [warn] slow request (1 args)
msgid=3 [log] hydrated (1 args)`;
    expect(parseConsole(text)).toEqual([
      { type: "error", text: "TypeError: orders is null" },
      { type: "warn", text: "slow request" },
      { type: "log", text: "hydrated" },
    ]);
  });
  it("ignores header/non-message lines", () => {
    expect(parseConsole(`## Console messages\nShowing 0-0 of 0`)).toEqual([]);
  });
});

describe("isOpenDialog", () => {
  it("detects the chrome-devtools-mcp open-dialog error (verified shape)", () => {
    const err = new Error(
      "# Open dialog\nconfirm: proceed?\nCall handle_dialog to handle it before continuing.",
    );
    expect(isOpenDialog(err)).toBe(true);
  });

  it("is false for an ordinary failure", () => {
    expect(isOpenDialog(new Error("no element matching"))).toBe(false);
    expect(isOpenDialog("plain string")).toBe(false);
  });
});

describe("snapshot freshness (#85)", () => {
  it("snapshot() re-fetches every call so a waitFor poll sees new content", async () => {
    const { driver, calls } = stubbedDriver({ take_snapshot: 'uid=1_1 button "Go"' });
    await driver.snapshot();
    await driver.snapshot();
    expect(calls.filter((c) => c.name === "take_snapshot")).toHaveLength(2);
  });

  it("locate() still reuses the snapshot taken in the same turn", async () => {
    const { driver, calls } = stubbedDriver({ take_snapshot: 'uid=1_1 button "Go"' });
    await driver.snapshot();
    await driver.locate({ text: "Go" });
    expect(calls.filter((c) => c.name === "take_snapshot")).toHaveLength(1);
  });
});

describe("Target.selector resolution (#91)", () => {
  it("resolves a selector by probing its accessible name and joining to the snapshot", async () => {
    const { driver, calls } = stubbedDriver({
      take_snapshot: 'uid=2_1 button "Cancel"\nuid=2_3 button "Submit order"',
      evaluate_script: 'Script ran on page and returned:\n```json\n{"name":"Submit order"}\n```',
      list_pages: "",
    });
    await driver.click({ selector: "#buy" });
    const click = calls.find((c) => c.name === "click");
    expect(click?.args.uid).toBe("2_3");
  });

  it("falls through to text locators when the selector matches nothing", async () => {
    const { driver, calls } = stubbedDriver({
      take_snapshot: 'uid=2_1 button "Cancel"',
      evaluate_script: "Script ran on page and returned:\n```json\nnull\n```",
      list_pages: "",
    });
    await driver.click({ selector: "#gone", text: "Cancel" });
    expect(calls.find((c) => c.name === "click")?.args.uid).toBe("2_1");
  });

  it("selectorProbeScript embeds the selector as a JSON string literal", () => {
    expect(selectorProbeScript('a[href="/x"]')).toContain('document.querySelector("a[href=\\"/x\\"]")');
  });
});

describe("followNewTab guard + verb coverage (#89)", () => {
  it("parsePageEntries reads url-ful and url-less pages", () => {
    const text = `1: about:blank\n2: Example Domain (https://example.com/) [selected]\n3: Untitled`;
    expect(parsePageEntries(text)).toEqual([
      { id: 1, url: "about:blank" },
      { id: 2, url: "https://example.com/" },
      { id: 3, url: undefined },
    ]);
  });

  it("does not follow a fresh about:blank or url-less tab", () => {
    const entries = parsePageEntries(`1: app (https://app/) [selected]\n2: about:blank\n3: Untitled`);
    expect(followableTab(entries, new Set([1]))).toBeUndefined();
  });

  it("follows the newest fresh real page", () => {
    const entries = parsePageEntries(`1: app (https://app/)\n2: pop (https://pay/) [selected]`);
    expect(followableTab(entries, new Set([1]))).toBe(2);
  });

  it("pressKey follows a new real tab (coverage beyond click)", async () => {
    const { driver, calls } = stubbedDriver({
      press_key: "",
      list_pages: "1: app (https://app/)\n2: receipt (https://app/receipt)",
      take_snapshot: "",
    });
    await driver.pressKey("Enter");
    expect(calls.find((c) => c.name === "select_page")?.args.pageId).toBe(2);
  });
});
