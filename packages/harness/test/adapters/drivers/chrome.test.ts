import { describe, expect, it } from "vitest";
import {
  ChromeDevToolsDriver,
  describeResolutionMiss,
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
  crossRoleCandidates,
  probedRole,
  reachableRolesProbeScript,
  selectorProbeScript,
} from "../../../src/adapters/drivers/chrome.js";

/** Driver whose MCP layer is a scripted stub — records calls, returns canned text per tool. */
function stubbedDriver(
  responses: Record<string, string | ((args: Record<string, unknown>) => string)>,
  opts?: ConstructorParameters<typeof ChromeDevToolsDriver>[0],
) {
  const driver = new ChromeDevToolsDriver(opts);
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

  it("parses form state from the attribute tail — real formatter tokens (#93)", () => {
    const snap = [
      `uid=2_1 checkbox "Terms" checkable checked`,
      `uid=2_2 checkbox "Marketing" checkable`,
      `uid=2_3 checkbox "Partial" checkable checked="mixed"`,
      `uid=2_4 button "Pay" disableable disabled`,
      `uid=2_5 textbox "Email" value="a@b.com"`,
      `uid=2_6 button "I have checked the box"`, // state words inside a NAME must not match
    ].join("\n");
    expect(parseElements(snap)).toEqual([
      { role: "checkbox", name: "Terms", checked: true },
      { role: "checkbox", name: "Marketing" },
      { role: "checkbox", name: "Partial", checked: "mixed" },
      { role: "button", name: "Pay", disabled: true },
      { role: "textbox", name: "Email", value: "a@b.com" },
      { role: "button", name: "I have checked the box" },
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

describe("session lifecycle guards (#98, #88)", () => {
  it("rejects any call after close() — a closed driver is not reusable", async () => {
    const d = new ChromeDevToolsDriver();
    await d.close();
    await expect(d.goto("https://example.com")).rejects.toThrow(/driver closed/);
  });

  it("fails fast when the transport died mid-run instead of reconnecting blank", async () => {
    const d = new ChromeDevToolsDriver();
    (d as unknown as { crashed: boolean }).crashed = true;
    await expect(d.goto("https://example.com")).rejects.toThrow(/mid-run/);
  });
});

describe("resolveTargetUid — nth among same-named elements (#92)", () => {
  // The list-UI repro: every row's action button carries the same accessible name.
  const LIST = `uid=5_0 button "Accept"
  uid=5_1 link "Details"
  uid=5_2 button "Accept"
  uid=5_3 button "Decline"
  uid=5_4 button "Accept"`;
  const rows = parseSnapshotRows(LIST);

  it("addresses the Nth name match (0-based, same convention as index)", () => {
    expect(resolveTargetUid(rows, { text: "Accept", role: "button", nth: 0 })).toBe("5_0");
    expect(resolveTargetUid(rows, { text: "Accept", role: "button", nth: 1 })).toBe("5_2");
    expect(resolveTargetUid(rows, { text: "Accept", role: "button", nth: 2 })).toBe("5_4");
  });

  it("counts only elements matching the role constraint", () => {
    const mixed = parseSnapshotRows(`uid=6_0 link "Accept"\nuid=6_1 button "Accept"\nuid=6_2 button "Accept"`);
    expect(resolveTargetUid(mixed, { text: "Accept", role: "button", nth: 1 })).toBe("6_2");
    expect(resolveTargetUid(mixed, { text: "Accept", nth: 1 })).toBe("6_1"); // role-less: every match counts
  });

  it("yields nothing when nth is out of range (the list shrank) instead of guessing", () => {
    expect(resolveTargetUid(rows, { text: "Accept", role: "button", nth: 3 })).toBeUndefined();
  });

  it("does not regress P3: an out-of-range nth never falls through to a positional guess", () => {
    expect(resolveTargetUid(rows, { text: "Accept", role: "button", index: 0, nth: 9 })).toBeUndefined();
  });

  it("refuses same-role duplicates without nth instead of guessing the first (#127)", () => {
    expect(resolveTargetUid(rows, { text: "Accept", role: "button" })).toBeUndefined();
  });

  it("applies nth to the substring pool when no exact name matches (M1 stays for nth-less targets)", () => {
    const subs = parseSnapshotRows(`uid=7_0 button "Add to cart"\nuid=7_1 button "Add to wishlist"`);
    expect(resolveTargetUid(subs, { text: "Add", nth: 1 })).toBe("7_1");
    expect(resolveTargetUid(subs, { text: "Add" })).toBeUndefined();
  });
});

describe("locate — nth enrichment for duplicate names (#92)", () => {
  // Only take_snapshot is needed for locate(); everything else is inert.
  function locatingDriver(snapshot: string): ChromeDevToolsDriver {
    const driver = new ChromeDevToolsDriver();
    (driver as unknown as { call: (name: string, args?: Record<string, unknown>) => Promise<string> }).call =
      async (name) => (name === "take_snapshot" ? snapshot : "");
    return driver;
  }
  const LIST = `uid=5_0 button "Accept"\nuid=5_2 button "Accept"\nuid=5_4 button "Accept"`;

  it("nth-less duplicates no longer enrich — resolution refuses the guess upstream (#127)", async () => {
    const t = await locatingDriver(LIST).locate({ text: "Accept" });
    expect(t).toEqual({ text: "Accept" }); // unenriched; execution will fail with the ambiguity message
  });

  it("keeps an author's nth and derives the structural index from the element it resolves to", async () => {
    const t = await locatingDriver(LIST).locate({ text: "Accept", nth: 2 });
    expect(t).toEqual({ text: "Accept", role: "button", index: 2, nth: 2 });
  });

  it("adds no nth when the name is unique", async () => {
    const t = await locatingDriver(`uid=1_1 button "Buy"`).locate({ text: "Buy" });
    expect(t).toEqual({ text: "Buy", role: "button", index: 0 });
    expect("nth" in t).toBe(false);
  });
});

describe("duplicate exact names (#127)", () => {
  const dup = `uid=5_1 link "Log in"\nuid=5_2 button "Log in"\nuid=5_3 button "Log in"`;

  it("refuses to guess among several exact matches without nth", () => {
    expect(resolveTargetUid(parseSnapshotRows(dup), { text: "Log in" })).toBeUndefined();
  });

  it("role alone resolves when it narrows to one", () => {
    expect(resolveTargetUid(parseSnapshotRows(dup), { text: "Log in", role: "link" })).toBe("5_1");
  });

  it("role + nth addresses the Nth same-named element", () => {
    expect(resolveTargetUid(parseSnapshotRows(dup), { text: "Log in", role: "button", nth: 1 })).toBe("5_3");
  });

  it("a single exact match still resolves without nth", () => {
    const single = `uid=6_1 button "Pay"`;
    expect(resolveTargetUid(parseSnapshotRows(single), { text: "Pay" })).toBe("6_1");
  });

  it("describeResolutionMiss names the ambiguity and the fix", () => {
    const msg = describeResolutionMiss(parseSnapshotRows(dup), { text: "Log in" });
    expect(msg).toContain('3 elements named "Log in"');
    expect(msg).toContain('"nth"');
  });

  it("describeResolutionMiss stays generic for a true miss", () => {
    expect(describeResolutionMiss(parseSnapshotRows(dup), { text: "Checkout" })).toContain("no element matching");
  });
});

describe("select — native fast-path vs custom dropdown (#: select-aria-native)", () => {
  const nativeSelect = 'Script ran on page and returned:\n```json\n{"tag":"SELECT"}\n```';
  const customButton = 'Script ran on page and returned:\n```json\n{"tag":"BUTTON"}\n```';

  it("drives a real native <select> with fill", async () => {
    const { driver, calls } = stubbedDriver({
      take_snapshot: 'uid=3_1 combobox "Size"',
      evaluate_script: nativeSelect,
    });
    (driver as unknown as { settle: () => Promise<void> }).settle = async () => {};
    await driver.select({ text: "Size" }, "Medium");
    expect(calls.find((c) => c.name === "fill")?.args).toEqual({ uid: "3_1", value: "Medium" });
  });

  it("opens a custom ARIA dropdown and clicks the matching option (watermark-scoped, never fill)", async () => {
    // The combobox is always present; its options render only after the open-click. A NATIVE
    // <select>'s options ("Small"/"Medium") are always in the tree — the watermark must not let
    // the custom pick mismatch them.
    let opened = false;
    const closed = 'uid=1 combobox "Size"\nuid=9 option "Medium"'; // uid=9 = a native select's option, pre-existing
    const open = closed + '\nuid=2 listbox "opts"\nuid=3 option "Small"\nuid=4 option "Medium"';
    const { driver, calls } = stubbedDriver({
      take_snapshot: () => (opened ? open : closed),
      evaluate_script: customButton,
      click: (args) => (args.uid === "1" ? ((opened = true), "") : ""),
    });
    (driver as unknown as { settle: () => Promise<void> }).settle = async () => {};
    await driver.select({ text: "Size" }, "Medium");
    const clicks = calls.filter((c) => c.name === "click");
    expect(clicks[0]?.args.uid).toBe("1"); // opened the combobox
    expect(clicks[1]?.args.uid).toBe("4"); // the fresh option, not the pre-existing uid=9
    expect(calls.some((c) => c.name === "fill")).toBe(false); // never no-ops a fill on a custom dropdown
  });

  it("throws when no matching option appears after opening (fail-closed)", async () => {
    const { driver, calls } = stubbedDriver({
      take_snapshot: 'uid=1 combobox "Size"', // opening reveals nothing
      evaluate_script: customButton,
    });
    (driver as unknown as { settle: () => Promise<void> }).settle = async () => {};
    await expect(driver.select({ text: "Size" }, "Medium")).rejects.toThrow(/no matching option/);
    expect(calls.some((c) => c.name === "fill")).toBe(false);
  });
});

describe("clickable-region promotion (#132)", () => {
  const snap = [
    'uid=1 StaticText "Product A"',
    'uid=2 StaticText "$10"',
    'uid=3 StaticText "Product B"',
    'uid=4 StaticText "Just text"',
  ].join("\n");
  const regions = (arr: number[]) =>
    `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify(arr)}\n\`\`\``;

  it("promotes one label per roleless clickable region (de-nested); leaves the rest StaticText", async () => {
    // probe: A & $10 = region 0, B = region 1, "Just text" = none (-1)
    const { driver } = stubbedDriver({ take_snapshot: snap, evaluate_script: regions([0, 0, 1, -1]) });
    const roleOf = Object.fromEntries((await driver.snapshot()).map((e) => [e.name, e.role]));
    expect(roleOf["Product A"]).toBe("button");
    expect(roleOf["Product B"]).toBe("button");
    expect(roleOf["$10"]).toBe("StaticText"); // same region as A → not a second clickable
    expect(roleOf["Just text"]).toBe("StaticText");
  });

  it("promoteClickables:false returns raw a11y roles and never probes", async () => {
    const { driver, calls } = stubbedDriver(
      { take_snapshot: snap, evaluate_script: regions([0, 0, 1, -1]) },
      { promoteClickables: false },
    );
    const roleOf = Object.fromEntries((await driver.snapshot()).map((e) => [e.name, e.role]));
    expect(roleOf["Product A"]).toBe("StaticText");
    expect(calls.some((c) => c.name === "evaluate_script")).toBe(false);
  });

  it("re-probes only when the raw snapshot changed (no cost on a static poll)", async () => {
    const { driver, calls } = stubbedDriver({ take_snapshot: snap, evaluate_script: regions([0, -1, 1, -1]) });
    await driver.snapshot();
    await driver.snapshot(); // same raw → reuse
    expect(calls.filter((c) => c.name === "evaluate_script")).toHaveLength(1);
    expect(calls.filter((c) => c.name === "take_snapshot")).toHaveLength(2); // still fresh each call (#85)
  });

  it("a probe that finds nothing promotes nothing", async () => {
    const { driver } = stubbedDriver({ take_snapshot: snap, evaluate_script: regions([-1, -1, -1, -1]) });
    expect((await driver.snapshot()).every((e) => e.role !== "button")).toBe(true);
  });
});

describe("cross-role duplicate names resolve to what the page shows (#176)", () => {
  // The failure shape: a modal's submit button and a background nav link share a name. Tree order
  // picks the link, so replay navigates away instead of submitting.
  const modal = 'uid=3_1 link "Continue"\nuid=3_2 button "Continue"';
  const probe = (reachable: string[], occluded: string[] = [], unknown: string[] = []) =>
    `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify({ reachable, occluded, unknown })}\n\`\`\``;

  it("clicks the reachable candidate, not the tree-order-first one", async () => {
    const { driver, calls } = stubbedDriver({
      take_snapshot: modal,
      evaluate_script: probe(["button"], ["link"]), // the backdrop covers the nav link
      list_pages: "",
    });
    await driver.click({ text: "Continue" });
    expect(calls.find((c) => c.name === "click")?.args.uid).toBe("3_2");
  });

  it("keeps tree order when nothing is reachable — the probe never makes things worse", async () => {
    const { driver, calls } = stubbedDriver({ take_snapshot: modal, evaluate_script: probe([]), list_pages: "" });
    await driver.click({ text: "Continue" });
    expect(calls.find((c) => c.name === "click")?.args.uid).toBe("3_1");
  });

  it("keeps tree order when the page refuses the probe", async () => {
    const { driver, calls } = stubbedDriver({
      take_snapshot: modal,
      evaluate_script: "not json at all",
      list_pages: "",
    });
    await driver.click({ text: "Continue" });
    expect(calls.find((c) => c.name === "click")?.args.uid).toBe("3_1");
  });

  it("leaves the a11y wrapper pair alone (link over StaticText is one element)", async () => {
    const { driver, calls } = stubbedDriver({
      take_snapshot: 'uid=1_3 link "Learn more"\nuid=1_4 StaticText "Learn more"',
      evaluate_script: probe(["link"], ["StaticText"]),
      list_pages: "",
    });
    await driver.click({ text: "Learn more" });
    expect(calls.find((c) => c.name === "click")?.args.uid).toBe("1_3");
  });

  it("never probes when the name is not ambiguous across roles", async () => {
    const { driver, calls } = stubbedDriver({ take_snapshot: 'uid=9 button "Pay"', list_pages: "" });
    await driver.click({ text: "Pay" });
    expect(calls.some((c) => c.name === "evaluate_script")).toBe(false);
  });

  it("locate freezes the reachable candidate's role, so replay never re-guesses", async () => {
    const { driver } = stubbedDriver({ take_snapshot: modal, evaluate_script: probe(["button"], ["link"]) });
    expect(await driver.locate({ text: "Continue" })).toMatchObject({ text: "Continue", role: "button" });
  });

  describe("crossRoleCandidates — which ambiguities the probe is for", () => {
    const rowsOf = (snap: string) => parseSnapshotRows(snap);
    it("reports the roles of a cross-role duplicate", () => {
      expect(crossRoleCandidates(rowsOf(modal), { text: "Continue" })).toEqual(["link", "button"]);
    });
    it("stays out of the same-role class (#127 refuses it instead of guessing)", () => {
      const same = 'uid=1 button "Log in"\nuid=2 button "Log in"';
      expect(crossRoleCandidates(rowsOf(same), { text: "Log in" })).toEqual([]);
    });
    it("stays out when the target already says which element it means", () => {
      expect(crossRoleCandidates(rowsOf(modal), { text: "Continue", role: "button" })).toEqual([]);
      expect(crossRoleCandidates(rowsOf(modal), { text: "Continue", nth: 1 })).toEqual([]);
    });
    it("stays out when the name resolves without a guess", () => {
      expect(crossRoleCandidates(rowsOf('uid=1 button "Pay"'), { text: "Pay" })).toEqual([]);
    });
    it("exact matches only — a substring match is a different (already unambiguous) path", () => {
      expect(crossRoleCandidates(rowsOf(modal), { text: "Contin" })).toEqual([]);
    });
  });

  it("abstains when the correct target is unmeasured — a visible decoy must not win", async () => {
    // The driver clicks through puppeteer's Locator, which scrolls first, so a button below the
    // fold is a fine click target. Narrowing to the decoy would freeze the wrong role for good.
    const { driver, calls } = stubbedDriver({
      take_snapshot: modal,
      evaluate_script: probe(["link"], [], ["button"]),
      list_pages: "",
    });
    await driver.click({ text: "Continue" });
    expect(calls.find((c) => c.name === "click")?.args.uid).toBe("3_1"); // tree order, unchanged
  });

  it("abstains when a candidate role is in no bucket at all — the probe never saw it", async () => {
    // A shadow-root button, an iframe, an `aria-labelledby` name, a role this script spells
    // differently: the element is in the snapshot and invisible to the probe. Narrowing on what is
    // left would pick the decoy, which is the failure this whole guard exists for.
    const { driver, calls } = stubbedDriver({
      take_snapshot: modal,
      evaluate_script: probe(["link"]), // "button" accounted for nowhere
      list_pages: "",
    });
    await driver.click({ text: "Continue" });
    expect(calls.find((c) => c.name === "click")?.args.uid).toBe("3_1"); // tree order, unchanged
  });

  it("still narrows when the unmeasured role is not one of the candidates", async () => {
    const { driver, calls } = stubbedDriver({
      take_snapshot: modal,
      evaluate_script: probe(["button"], ["link"], ["textbox"]),
      list_pages: "",
    });
    await driver.click({ text: "Continue" });
    expect(calls.find((c) => c.name === "click")?.args.uid).toBe("3_2");
  });

  it("a fixed candidate, or one under a fixed ancestor, is never 'clipped' by a scroll box", () => {
    // A modal rendered in place inside a scrolled container: `position: fixed` escapes the
    // ancestor's overflow clip, so treating it as clipped would abstain on the very shape #176 is
    // for. Verified in a real browser against the maintainer's fixture.
    const script = reachableRolesProbeScript("Continue");
    expect(script).toContain('getComputedStyle(el).position === "fixed"');
    expect(script).toContain('st.position === "fixed"');
  });

  it("treats a candidate clipped by its own scroll container as unmeasured, not covered", () => {
    // The script decides this in-page; what the unit can pin is that the rule is asked before the
    // hit test, since a clipped candidate's centre lands on whatever the page shows there.
    const script = reachableRolesProbeScript("Continue");
    expect(script).toContain("clippedByOwnBox");
    expect(script.indexOf("clippedByOwnBox(el, x, y)")).toBeLessThan(script.indexOf("elementFromPoint"));
    // and the walk stops before <body>, or a root-scrolling page would abstain on every backdrop
    expect(script).toContain("p !== document.body");
  });

  it("reads an input's value as its name (<input type=submit value=Continue>)", () => {
    expect(reachableRolesProbeScript("Continue")).toContain('getAttribute("value")');
  });

  describe("probedRole — narrow only when the answer is single and real", () => {
    it("narrows to the one reachable role that exists in the snapshot pool", () => {
      expect(probedRole(["link", "button"], { reachable: ["button"], occluded: ["link"] })).toBe("button");
    });
    it("refuses two genuinely visible same-named controls", () => {
      expect(probedRole(["link", "button"], { reachable: ["button", "link"] })).toBeUndefined();
    });
    it("ignores a reachable role the snapshot pool does not contain", () => {
      expect(probedRole(["link", "button"], { reachable: ["textbox"] })).toBeUndefined();
    });
    it("nothing reachable narrows nothing", () => {
      expect(probedRole(["link", "button"], { reachable: [] })).toBeUndefined();
    });
    it("an unmeasured candidate blocks the narrowing", () => {
      expect(probedRole(["link", "button"], { reachable: ["link"], unknown: ["button"] })).toBeUndefined();
    });
    it("a candidate the probe placed in no bucket blocks it", () => {
      expect(probedRole(["link", "button"], { reachable: ["link"] })).toBeUndefined();
    });
    it("an unmeasured role outside the pool does not", () => {
      expect(probedRole(["link", "button"], { reachable: ["link"], occluded: ["button"], unknown: ["textbox"] })).toBe("link");
    });
  });

  it("reachableRolesProbeScript is a parseable function carrying the wanted name", () => {
    const script = reachableRolesProbeScript("  Continue  ");
    expect(script).toContain('const want = "continue"');
    expect(() => new Function(`return ${script}`)).not.toThrow();
    // The script is built inside template literals, where an unescaped \s silently becomes "s" —
    // the whitespace-collapsing regex then matches literal letters instead (caught in a browser).
    expect(script).toContain("replace(/\\s+/g");
  });
});

import { afterEach, vi, beforeEach } from "vitest";

const sdk = vi.hoisted(() => {
  const state = {
    connect: vi.fn(async (_t: unknown) => {}),
    callTool: vi.fn(async (_r: unknown) => ({ content: [] })),
    transportClose: vi.fn(async () => {}),
    transports: [] as Array<{ onclose?: () => void; close: () => Promise<void>; params: unknown }>,
  };
  return state;
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = sdk.connect;
    callTool = sdk.callTool;
    close = vi.fn(async () => {});
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    onclose?: () => void;
    close = sdk.transportClose;
    constructor(public readonly params: unknown) {
      sdk.transports.push(this);
    }
  },
}));

// Consolidated audit coverage.

describe("ChromeDevToolsDriver audit coverage", () => {

  function stubbedDriver(
    responses: Record<string, string | ((args: Record<string, unknown>) => string)>,
    opts?: ConstructorParameters<typeof ChromeDevToolsDriver>[0],
  ) {
    const driver = new ChromeDevToolsDriver(opts);
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    (driver as unknown as { call: unknown }).call = async (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });
      const r = responses[name];
      if (r === undefined) return "";
      return typeof r === "function" ? r(args) : r;
    };
    return { driver, calls };
  }

  const net = (n: number) =>
    Array.from({ length: n }, (_, i) => `reqid=${i} GET https://x/${i} [200]`).join("\n");

  /** Driver whose MCP client is a fake object — exercises the real `call()` layer above it. */
  function withClient(callTool: (req: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>, opts?: ConstructorParameters<typeof ChromeDevToolsDriver>[0]) {
    const driver = new ChromeDevToolsDriver(opts);
    const client = { callTool: vi.fn(callTool), close: vi.fn(async () => {}) };
    (driver as unknown as { client: unknown }).client = client;
    return { driver, client };
  }

  beforeEach(() => {
    sdk.transports.length = 0;
    sdk.connect.mockReset().mockImplementation(async () => {});
    sdk.callTool.mockReset().mockImplementation(async () => ({ content: [] }));
    sdk.transportClose.mockClear();
  });

  // chrome-call-accepting-accepts-dialog-and-follows-new-tab.test.ts
  {
    describe("chrome callAccepting", () => {
      it("chromeCallAcceptingAcceptsDialogAndFollowsNewTab: an open-dialog error is answered with handle_dialog accept, then list_pages runs", async () => {
        let clicks = 0;
        const { driver, calls } = stubbedDriver({
          take_snapshot: 'uid=1_1 button "Delete"',
          click: () => {
            clicks++;
            throw new Error("# Open dialog\nconfirm: sure?\nCall handle_dialog to handle it before continuing.");
          },
          list_pages: "1: Home (https://x/) [selected]",
        });
        await driver.click({ text: "Delete" });
        const names = calls.map((c) => c.name);
        expect(clicks).toBe(1); // the click's handler already fired — not retried
        expect(calls.find((c) => c.name === "handle_dialog")?.args).toEqual({ action: "accept" });
        expect(names.indexOf("list_pages")).toBeGreaterThan(names.indexOf("handle_dialog"));
      });
    });
  }

  // chrome-call-accepting-rethrows-non-dialog-errors.test.ts
  {
    describe("chrome callAccepting", () => {
      it("chromeCallAcceptingRethrowsNonDialogErrors: an ordinary MCP failure propagates and no dialog is touched", async () => {
        const { driver, calls } = stubbedDriver({
          take_snapshot: 'uid=1_1 button "Go"',
          click: () => {
            throw new Error("MCP click failed: element detached");
          },
        });
        await expect(driver.click({ text: "Go" })).rejects.toThrow(/element detached/);
        expect(calls.some((c) => c.name === "handle_dialog")).toBe(false);
        expect(calls.some((c) => c.name === "list_pages")).toBe(false);
      });
    });
  }

  // chrome-call-accepting-switches-to-a-fresh-tab.test.ts
  {
    describe("chrome callAccepting", () => {
      it("chromeCallAcceptingSwitchesToAFreshTab: a real new page after the action is selected; an about:blank shell is not", async () => {
        let pages = "1: Home (https://x/) [selected]";
        const { driver, calls } = stubbedDriver({
          take_snapshot: 'uid=1_1 link "Open"',
          navigate_page: "",
          list_pages: () => pages,
        });
        await driver.goto("https://x/"); // tracks page 1 as seen
        pages = "1: Home (https://x/) [selected]\n2: about:blank";
        await driver.click({ text: "Open" });
        expect(calls.some((c) => c.name === "select_page")).toBe(false);
        pages = "1: Home (https://x/) [selected]\n2: about:blank\n3: Doc (https://x/doc)";
        await driver.click({ text: "Open" });
        expect(calls.find((c) => c.name === "select_page")?.args).toEqual({ pageId: 3 });
      });
    });
  }

  // chrome-call-joins-text-content-blocks.test.ts
  {
    describe("chrome call()", () => {
      it("chromeCallJoinsTextContentBlocks: multiple text blocks are joined with newlines, non-text blocks skipped", async () => {
        const { driver, client } = withClient(async ({ name }) => {
          if (name === "list_network_requests") {
            return {
              content: [
                { type: "text", text: "reqid=1 GET https://a/ [200]" },
                { type: "image", data: "xx" },
                { type: "text", text: "reqid=2 POST https://b/ [500]" },
              ],
            };
          }
          return { content: [] };
        });
        const ev = await driver.observe();
        expect(ev.logic.requests).toEqual([
          { method: "GET", url: "https://a/", status: 200 },
          { method: "POST", url: "https://b/", status: 500 },
        ]);
        expect(client.callTool).toHaveBeenCalledWith({ name: "list_network_requests", arguments: {} });
      });
    });
  }

  // chrome-call-refuses-after-close.test.ts
  {
    describe("chrome call()", () => {
      it("chromeCallRefusesAfterClose: close() is terminal — a later call throws `driver closed`", async () => {
        const { driver, client } = withClient(async () => ({ content: [] }));
        await driver.close();
        expect(client.close).toHaveBeenCalled();
        await expect(driver.goto("https://x/")).rejects.toThrow(/driver closed/);
      });
    });
  }

  // chrome-call-rejects-after-per-call-timeout.test.ts
  {
    describe("chrome call()", () => {
      it("chromeCallRejectsAfterPerCallTimeout: a tool call that never settles rejects with the timeout message", async () => {
        const { driver } = withClient(() => new Promise(() => {}), { timeoutMs: 20 });
        await expect(driver.goto("https://x/")).rejects.toThrow("MCP navigate_page timed out after 20ms");
      });
    });
  }

  // chrome-call-throws-on-is-error-result.test.ts
  {
    describe("chrome call()", () => {
      it("chromeCallThrowsOnIsErrorResult: an isError tool result throws `MCP <tool> failed: <text>`", async () => {
        const { driver } = withClient(async () => ({
          isError: true,
          content: [{ type: "text", text: "no page selected" }],
        }));
        await expect(driver.observe()).rejects.toThrow(/^MCP list_pages failed: no page selected/);
      });
    });
  }

  // chrome-connect-failure-wraps-and-closes-transport.test.ts
  {
    describe("chrome ensureConnected", () => {
      it("chromeConnectFailureWrapsAndClosesTransport: a failed connect throws `failed to start chrome-devtools-mcp: …` and closes the spawned transport", async () => {
        sdk.connect.mockImplementation(async () => {
          throw new Error("ENOENT npx");
        });
        const driver = new ChromeDevToolsDriver();
        await expect(driver.goto("https://x/")).rejects.toThrow("failed to start chrome-devtools-mcp: ENOENT npx");
        expect(sdk.transportClose).toHaveBeenCalledTimes(1);
      });
    });
  }

  // chrome-connect-passes-command-and-args-to-transport.test.ts
  {
    describe("chrome ensureConnected", () => {
      it("chromeConnectPassesCommandAndArgsToTransport: custom command/args reach the stdio transport; the default pins chrome-devtools-mcp@~1.3.0 --isolated", async () => {
        await new ChromeDevToolsDriver({ command: "my-mcp", args: ["--flag"] }).goto("https://x/");
        expect(sdk.transports[0]!.params).toEqual({ command: "my-mcp", args: ["--flag"] });
        await new ChromeDevToolsDriver().goto("https://x/");
        expect(sdk.transports[1]!.params).toEqual({ command: "npx", args: ["-y", "chrome-devtools-mcp@~1.3.0", "--isolated"] });
      });
    });
  }

  // chrome-connect-times-out-via-connect-timeout-ms.test.ts
  {
    describe("chrome ensureConnected", () => {
      it("chromeConnectTimesOutViaConnectTimeoutMs: a hung connect rejects after connectTimeoutMs, wrapped as a start failure", async () => {
        sdk.connect.mockImplementation(() => new Promise(() => {}));
        const driver = new ChromeDevToolsDriver({ connectTimeoutMs: 15 });
        await expect(driver.goto("https://x/")).rejects.toThrow(
          "failed to start chrome-devtools-mcp: chrome-devtools-mcp connect timed out after 15ms",
        );
        expect(sdk.transportClose).toHaveBeenCalledTimes(1);
      });
    });
  }

  // chrome-double-click-passes-dbl-click-flag.test.ts
  {
    describe("chrome verbs", () => {
      it("chromeDoubleClickPassesDblClickFlag: doubleClick sends click with dblClick:true; click sends none", async () => {
        const { driver, calls } = stubbedDriver({ take_snapshot: 'uid=1_1 button "Cell"', list_pages: "" });
        await driver.doubleClick({ text: "Cell" });
        await driver.click({ text: "Cell" });
        const clicks = calls.filter((c) => c.name === "click").map((c) => c.args);
        expect(clicks).toEqual([{ uid: "1_1", dblClick: true }, { uid: "1_1" }]);
      });
    });
  }

  // chrome-goto-accepts-before-unload-and-tracks-pages.test.ts
  {
    describe("chrome verbs", () => {
      it("chromeGotoAcceptsBeforeUnloadAndTracksPages: navigate_page carries handleBeforeUnload:accept, pages listed after it are remembered as seen", async () => {
        let pages = "1: Home (https://x/) [selected]\n2: Other (https://x/o)";
        const { driver, calls } = stubbedDriver({
          take_snapshot: 'uid=1_1 link "Go"',
          list_pages: () => pages,
        });
        await driver.goto("https://x/");
        expect(calls.find((c) => c.name === "navigate_page")?.args).toEqual({
          type: "url",
          url: "https://x/",
          handleBeforeUnload: "accept",
        });
        pages = "1: Home (https://x/)\n2: Other (https://x/o) [selected]"; // both already seen → no switch
        await driver.click({ text: "Go" });
        expect(calls.some((c) => c.name === "select_page")).toBe(false);
      });
    });
  }

  // chrome-hover-and-press-key-route-to-their-tools.test.ts
  {
    describe("chrome verbs", () => {
      it("chromeHoverAndPressKeyRouteToTheirTools: hover sends the resolved uid; pressKey sends {key} through the dialog-accepting path", async () => {
        const { driver, calls } = stubbedDriver({ take_snapshot: 'uid=1_1 button "Menu"', list_pages: "" });
        await driver.hover({ text: "Menu" });
        await driver.pressKey("Enter");
        expect(calls.find((c) => c.name === "hover")?.args).toEqual({ uid: "1_1" });
        expect(calls.find((c) => c.name === "press_key")?.args).toEqual({ key: "Enter" });
        const names = calls.map((c) => c.name);
        expect(names.indexOf("list_pages")).toBeGreaterThan(names.indexOf("press_key"));
      });
    });
  }

  // chrome-normalize-url-non-url-fallback.test.ts
  {
    describe("chrome normalizeUrl", () => {
      it("chromeNormalizeUrlNonUrlFallback: a string the URL parser rejects only loses trailing slashes/hashes; a parseable one keeps its query", () => {
        expect(normalizeUrl("/relative/path/#")).toBe("/relative/path");
        expect(normalizeUrl("not a url//")).toBe("not a url");
        expect(normalizeUrl("https://x.com/p/?q=1#top")).toBe("https://x.com/p?q=1");
      });
    });
  }

  // chrome-observe-navigated-only-when-url-moved-from-initial.test.ts
  {
    describe("chrome observe", () => {
      it("chromeObserveNavigatedOnlyWhenUrlMovedFromInitial: goto sets the baseline; same url (trailing slash) → false, another url → true, evidence composed from the three lists", async () => {
        let selected = "https://x.com/";
        const { driver } = stubbedDriver({
          navigate_page: "",
          list_pages: () => `1: Home (${selected}) [selected]`,
          list_network_requests: "reqid=1 GET https://x.com/api [500]",
          list_console_messages: "msgid=1 [error] boom (1 args)",
        });
        await driver.goto("https://x.com");
        const same = await driver.observe();
        expect(same.execution).toEqual({ actions: [], navigated: false, finalUrl: "https://x.com/", blocked: false });
        expect(same.logic).toEqual({
          requests: [{ method: "GET", url: "https://x.com/api", status: 500 }],
          console: [{ type: "error", text: "boom" }],
        });
        expect(same.perception).toEqual({});
        selected = "https://x.com/done";
        await driver.goto("https://x.com/step2"); // initialUrl stays the FIRST goto
        expect((await driver.observe()).execution.navigated).toBe(true);
      });
    });
  }

  // chrome-observe-without-goto-treats-any-url-as-navigated.test.ts
  {
    describe("chrome observe", () => {
      it("chromeObserveWithoutGotoTreatsAnyUrlAsNavigated: no initial url → navigated true; no selected page → finalUrl undefined and navigated false", async () => {
        let pages = "1: Home (https://x/) [selected]";
        const { driver } = stubbedDriver({ list_pages: () => pages });
        expect((await driver.observe()).execution.navigated).toBe(true);
        pages = "";
        const ev = await driver.observe();
        expect(ev.execution.finalUrl).toBeUndefined();
        expect(ev.execution.navigated).toBe(false);
      });
    });
  }

  // chrome-promoted-clickables-capped-at-forty.test.ts
  {
    describe("chrome probeClickableLabels", () => {
      it("chromePromotedClickablesCappedAtForty: 50 distinct clickable regions promote only the first 40 labels", async () => {
        const snap = Array.from({ length: 50 }, (_, i) => `uid=${i} StaticText "Card ${i}"`).join("\n");
        const regions = JSON.stringify(Array.from({ length: 50 }, (_, i) => i));
        const { driver } = stubbedDriver({
          take_snapshot: snap,
          evaluate_script: `Script ran on page and returned:\n\`\`\`json\n${regions}\n\`\`\``,
        });
        const els = await driver.snapshot();
        expect(els.filter((e) => e.role === "button")).toHaveLength(40);
        expect(els[39]?.role).toBe("button");
        expect(els[40]?.role).toBe("StaticText");
      });
    });
  }

  // chrome-promotion-is-best-effort.test.ts
  {
    describe("chrome probeClickableLabels", () => {
      it("chromePromotionIsBestEffort: a throwing or non-array probe promotes nothing; promoteClickables:false skips the probe entirely", async () => {
        const snap = 'uid=1 StaticText "Card"';
        const throwing = stubbedDriver({
          take_snapshot: snap,
          evaluate_script: () => {
            throw new Error("MCP evaluate_script failed: CSP");
          },
        });
        expect((await throwing.driver.snapshot())[0]?.role).toBe("StaticText");
        const junk = stubbedDriver({ take_snapshot: snap, evaluate_script: "Script ran on page and returned:\n```json\n{\"a\":1}\n```" });
        expect((await junk.driver.snapshot())[0]?.role).toBe("StaticText");
        const off = stubbedDriver({ take_snapshot: snap, evaluate_script: "Script ran on page and returned:\n```json\n[0]\n```" }, { promoteClickables: false });
        expect((await off.driver.snapshot())[0]?.role).toBe("StaticText");
        expect(off.calls.some((c) => c.name === "evaluate_script")).toBe(false);
      });
    });
  }

  // chrome-promotion-reprobes-only-when-tree-changes.test.ts
  {
    describe("chrome probeClickableLabels", () => {
      it("chromePromotionReprobesOnlyWhenTreeChanges: a static page re-snapshotted twice runs the DOM probe once; a changed tree probes again", async () => {
        let snap = 'uid=1 StaticText "Card"';
        const { driver, calls } = stubbedDriver({
          take_snapshot: () => snap,
          evaluate_script: "Script ran on page and returned:\n```json\n[0]\n```",
        });
        await driver.snapshot();
        await driver.snapshot();
        expect(calls.filter((c) => c.name === "evaluate_script")).toHaveLength(1);
        snap = 'uid=1 StaticText "Card"\nuid=2 StaticText "New"';
        await driver.snapshot();
        expect(calls.filter((c) => c.name === "evaluate_script")).toHaveLength(2);
      });
    });
  }

  // chrome-resolve-uid-finds-late-rendered-element-on-retry.test.ts
  {
    describe("chrome resolveUid", () => {
      afterEach(() => vi.useRealTimers());

      it("chromeResolveUidFindsLateRenderedElementOnRetry: an element absent from the first snapshot and present on the second resolves without failing", async () => {
        vi.useFakeTimers();
        let n = 0;
        const { driver, calls } = stubbedDriver({
          take_snapshot: () => (++n >= 2 ? 'uid=1_1 button "Other"\nuid=1_2 button "Late"' : 'uid=1_1 button "Other"'),
          list_pages: "",
        });
        const p = driver.click({ text: "Late" });
        await vi.advanceTimersByTimeAsync(300);
        await p;
        expect(calls.find((c) => c.name === "click")?.args).toEqual({ uid: "1_2" });
        expect(calls.filter((c) => c.name === "take_snapshot")).toHaveLength(2);
      });
    });
  }

  // chrome-resolve-uid-names-ambiguity-after-retries.test.ts
  {
    describe("chrome resolveUid", () => {
      afterEach(() => vi.useRealTimers());

      it("chromeResolveUidNamesAmbiguityAfterRetries: same-role duplicates are refused on every attempt and the final error tells how to fix it", async () => {
        vi.useFakeTimers();
        const { driver } = stubbedDriver({ take_snapshot: 'uid=1 button "Accept"\nuid=2 button "Accept"' });
        const p = driver.click({ text: "Accept" });
        p.catch(() => {});
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(p).rejects.toThrow('2 elements named "Accept" (button) — add "role"');
      });
    });
  }

  // chrome-resolve-uid-retries-then-reports-miss.test.ts
  {
    describe("chrome resolveUid", () => {
      afterEach(() => vi.useRealTimers());

      it("chromeResolveUidRetriesThenReportsMiss: 4 snapshots 300ms apart, then throws describeResolutionMiss", async () => {
        vi.useFakeTimers();
        const { driver, calls } = stubbedDriver({ take_snapshot: 'uid=1_1 button "Other"' });
        const p = driver.click({ text: "Missing" });
        p.catch(() => {});
        await vi.advanceTimersByTimeAsync(850);
        expect(calls.filter((c) => c.name === "take_snapshot")).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(100);
        await expect(p).rejects.toThrow('no element matching {"text":"Missing"}');
        expect(calls.filter((c) => c.name === "take_snapshot")).toHaveLength(4);
        expect(calls.some((c) => c.name === "click")).toBe(false);
      });
    });
  }

  // chrome-screenshot-builds-data-url-from-image-block.test.ts
  {
    describe("chrome screenshot", () => {
      it("chromeScreenshotBuildsDataUrlFromImageBlock: the mimeType of the image block and base64 data become a data URL, png by default", async () => {
        const { driver, client } = withClient(async () => ({
          content: [{ type: "text", text: "Took a screenshot" }, { type: "image", data: "AAAA", mimeType: "image/png" }],
        }));
        expect(await driver.screenshot()).toBe("data:image/png;base64,AAAA");
        expect(client.callTool).toHaveBeenCalledWith({ name: "take_screenshot", arguments: { format: "png" } });
        const { driver: d2 } = withClient(async () => ({ content: [{ type: "image", data: "BBBB" }] }));
        expect(await d2.screenshot()).toBe("data:image/png;base64,BBBB");
      });
    });
  }

  // chrome-screenshot-is-best-effort.test.ts
  {
    describe("chrome screenshot", () => {
      it("chromeScreenshotIsBestEffort: a failing or image-less tool call yields undefined, never a throw", async () => {
        const { driver } = withClient(async () => {
          throw new Error("MCP take_screenshot failed");
        });
        expect(await driver.screenshot()).toBeUndefined();
        const { driver: d2 } = withClient(async () => ({ content: [{ type: "text", text: "nothing" }] }));
        expect(await d2.screenshot()).toBeUndefined();
        const d3 = new ChromeDevToolsDriver();
        await d3.close();
        expect(await d3.screenshot()).toBeUndefined(); // ensureConnected throws → swallowed
      });
    });
  }

  // chrome-scroll-builds-signed-scroll-by.test.ts
  {
    describe("chrome verbs", () => {
      it("chromeScrollBuildsSignedScrollBy: up negates innerHeight, down (default) does not, both via evaluate_script", async () => {
        const { driver, calls } = stubbedDriver({});
        await driver.scroll("up");
        await driver.scroll();
        const fns = calls.filter((c) => c.name === "evaluate_script").map((c) => String(c.args.function));
        expect(fns[0]).toContain("window.scrollBy(0, -window.innerHeight * 0.9)");
        expect(fns[1]).toContain("window.scrollBy(0, window.innerHeight * 0.9)");
      });
    });
  }

  // chrome-select-falls-back-to-single-substring-option.test.ts
  {
    describe("chrome awaitNewOption", () => {
      const customButton = 'Script ran on page and returned:\n```json\n{"tag":"BUTTON"}\n```';

      it("chromeSelectFallsBackToSingleSubstringOption: with no exact option name, one substring match is picked", async () => {
        let opened = false;
        const { driver, calls } = stubbedDriver({
          take_snapshot: () =>
            'uid=1 combobox "Size"' + (opened ? '\nuid=3 option "Small (S)"\nuid=4 option "Medium (M)"' : ""),
          evaluate_script: customButton,
          click: (args) => (args.uid === "1" ? ((opened = true), "") : ""),
        });
        (driver as unknown as { settle: () => Promise<void> }).settle = async () => {};
        await driver.select({ text: "Size" }, "medium");
        expect(calls.filter((c) => c.name === "click").map((c) => c.args.uid)).toEqual(["1", "4"]);
      });
    });
  }

  // chrome-select-refuses-two-exact-option-matches.test.ts
  {
    describe("chrome awaitNewOption", () => {
      afterEach(() => vi.useRealTimers());
      const customButton = 'Script ran on page and returned:\n```json\n{"tag":"BUTTON"}\n```';

      it("chromeSelectRefusesTwoExactOptionMatches: two options named exactly `value` is ambiguous — polls until the 2s deadline then throws", async () => {
        vi.useFakeTimers();
        let opened = false;
        const { driver, calls } = stubbedDriver({
          take_snapshot: () =>
            'uid=1 combobox "Size"' + (opened ? '\nuid=3 option "Medium"\nuid=4 option "Medium"' : ""),
          evaluate_script: customButton,
          click: (args) => (args.uid === "1" ? ((opened = true), "") : ""),
        });
        (driver as unknown as { settle: () => Promise<void> }).settle = async () => {};
        const p = driver.select({ text: "Size" }, "Medium");
        p.catch(() => {});
        await vi.advanceTimersByTimeAsync(2_500);
        await expect(p).rejects.toThrow('select "Medium": no matching option appeared');
        expect(calls.filter((c) => c.name === "click")).toHaveLength(1); // never guessed one of the two
        expect(calls.filter((c) => c.name === "take_snapshot").length).toBeGreaterThan(5); // it kept polling
      });
    });
  }

  // chrome-select-waits-for-portal-rendered-option.test.ts
  {
    describe("chrome awaitNewOption", () => {
      afterEach(() => vi.useRealTimers());
      const customButton = 'Script ran on page and returned:\n```json\n{"tag":"BUTTON"}\n```';

      it("chromeSelectWaitsForPortalRenderedOption: an option that appears only on a later poll is still picked (bounded wait)", async () => {
        vi.useFakeTimers();
        let polls = 0;
        const { driver, calls } = stubbedDriver({
          take_snapshot: () => 'uid=1 combobox "Size"' + (++polls >= 4 ? '\nuid=4 option "Medium"' : ""),
          evaluate_script: customButton,
        });
        (driver as unknown as { settle: () => Promise<void> }).settle = async () => {};
        const p = driver.select({ text: "Size" }, "Medium");
        await vi.advanceTimersByTimeAsync(600);
        await p;
        expect(calls.filter((c) => c.name === "click").map((c) => c.args.uid)).toEqual(["1", "4"]);
      });
    });
  }

  // chrome-settle-gives-up-at-the-ten-second-deadline.test.ts
  {
    describe("chrome settle", () => {
      afterEach(() => vi.useRealTimers());

      it("chromeSettleGivesUpAtTheTenSecondDeadline: a page that never goes idle resolves at 10s instead of hanging", async () => {
        vi.useFakeTimers();
        let count = 0;
        const { driver } = stubbedDriver({ list_network_requests: () => net((count += 2)) });
        let done = false;
        const p = driver.settle().then(() => (done = true));
        await vi.advanceTimersByTimeAsync(9_500);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1_000);
        await p;
        expect(done).toBe(true);
      });
    });
  }

  // chrome-settle-returns-once-idle-for-one-second.test.ts
  {
    describe("chrome settle", () => {
      afterEach(() => vi.useRealTimers());

      it("chromeSettleReturnsOnceIdleForOneSecond: a constant request count resolves after the 1s idle window, not before", async () => {
        vi.useFakeTimers();
        const { driver, calls } = stubbedDriver({ list_network_requests: net(5) });
        let done = false;
        const p = driver.settle().then(() => (done = true));
        await vi.advanceTimersByTimeAsync(700);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(600);
        await p;
        expect(done).toBe(true);
        expect(calls.filter((c) => c.name === "list_network_requests").length).toBeGreaterThanOrEqual(4);
      });
    });
  }

  // chrome-settle-swallows-mcp-errors.test.ts
  {
    describe("chrome settle", () => {
      it("chromeSettleSwallowsMcpErrors: a failing list_network_requests resolves settle instead of failing the run", async () => {
        const driver = new ChromeDevToolsDriver();
        (driver as unknown as { call: unknown }).call = async () => {
          throw new Error("MCP list_network_requests failed: boom");
        };
        await expect(driver.settle({ timeoutMs: 100 })).resolves.toBeUndefined();
      });
    });
  }

  // chrome-settle-tolerates-one-background-request.test.ts
  {
    describe("chrome settle", () => {
      afterEach(() => vi.useRealTimers());

      it("chromeSettleToleratesOneBackgroundRequest: one new request inside the window does not reset it, two do", async () => {
        vi.useFakeTimers();
        let count = 5;
        const { driver } = stubbedDriver({ list_network_requests: () => net(count) });
        // one trickle beacon at 250ms → still idle at ~1s
        let done = false;
        const p = driver.settle().then(() => (done = true));
        await vi.advanceTimersByTimeAsync(200);
        count = 6;
        await vi.advanceTimersByTimeAsync(1_100);
        await p;
        expect(done).toBe(true);

        // a burst of two resets the window: not idle at 1.1s, idle by ~1.6s
        count = 10;
        let done2 = false;
        const p2 = driver.settle().then(() => (done2 = true));
        await vi.advanceTimersByTimeAsync(400);
        count = 12; // seen on the poll at 500ms → reset
        await vi.advanceTimersByTimeAsync(700); // t=1.1s
        expect(done2).toBe(false);
        await vi.advanceTimersByTimeAsync(600); // t=1.7s
        await p2;
        expect(done2).toBe(true);
      });
    });
  }

  // chrome-transport-close-marks-session-crashed.test.ts
  {
    describe("chrome ensureConnected", () => {
      it("chromeTransportCloseMarksSessionCrashed: after the transport onclose callback fires mid-run, the next call fails instead of silently reconnecting", async () => {
        const driver = new ChromeDevToolsDriver();
        await driver.goto("https://x/");
        expect(sdk.connect).toHaveBeenCalledTimes(1);
        sdk.transports[0]!.onclose?.();
        await expect(driver.goto("https://y/")).rejects.toThrow(/browser session ended mid-run/);
        expect(sdk.connect).toHaveBeenCalledTimes(1); // no reconnect
      });
    });
  }

  // chrome-type-fills-then-follows-tab-then-settles.test.ts
  {
    describe("chrome verbs", () => {
      it("chromeTypeFillsThenFollowsTabThenSettles: type runs fill via callAccepting (list_pages after it) and then settle, in that order", async () => {
        const { driver, calls } = stubbedDriver({ take_snapshot: 'uid=1_1 textbox "Email"', list_pages: "" });
        (driver as unknown as { settle: () => Promise<void> }).settle = async () => {
          calls.push({ name: "<settle>", args: {} });
        };
        await driver.type({ text: "Email" }, "a@b.c");
        const names = calls.map((c) => c.name).filter((n) => n !== "take_snapshot");
        expect(names).toEqual(["fill", "list_pages", "<settle>"]);
        expect(calls.find((c) => c.name === "fill")?.args).toEqual({ uid: "1_1", value: "a@b.c" });
      });
    });
  }

});
