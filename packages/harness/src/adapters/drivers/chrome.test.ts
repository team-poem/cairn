import { describe, expect, it } from "vitest";
import {
  findUidByName,
  isNavigation,
  normalizeUrl,
  parseConsole,
  parseElements,
  parseNetwork,
  parsePageIds,
  parseSelectedUrl,
} from "./chrome.js";

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
  it("captures typed console rows", () => {
    const text = `## Console messages
error: TypeError: orders is null
info: hydrated`;
    expect(parseConsole(text)).toEqual([
      { type: "error", text: "TypeError: orders is null" },
      { type: "info", text: "hydrated" },
    ]);
  });
});
