/**
 * The probe against real layout (#176). Everything else in this engine is a pure function over
 * captured text, but `reachableRolesProbeScript` runs inside the page and reads what only a layout
 * engine can answer — element boxes, hit testing, an ancestor's computed overflow and position.
 * jsdom returns zeros for all of it, so these run in headless Chromium via `npm run test:browser`,
 * and are excluded from `npm test` so the everyday suite needs no browser.
 *
 * Each case is a file in `../fixtures/probe`, and the expectation is the whole bucket object: what
 * makes a probe wrong is not a missing role but a role in the wrong bucket.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { reachableRolesProbeScript } from "../../src/adapters/drivers/chrome.js";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/probe/${name}`, import.meta.url));

let browser: Browser;
beforeAll(async () => {
  // The installed Chrome, not a downloaded chromium: this engine drives the user's real Chrome
  // through chrome-devtools-mcp, so the browser that answers these fixtures should be the same one.
  // Falling back keeps a machine without Chrome (or a container) able to run the suite.
  browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
});
afterAll(async () => {
  await browser?.close();
});

/** Load a fixture and run the shipped probe script in it, exactly as the driver would. */
async function probe(name: string): Promise<{ reachable: string[]; occluded: string[]; unknown: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.setContent(await readFile(fixture(name), "utf8"));
    return await page.evaluate(`(${reachableRolesProbeScript("Continue")})()`);
  } finally {
    await page.close();
  }
}

describe("the probe against real layout", () => {
  it("calls a backdrop-covered link occluded and the modal button reachable", async () => {
    expect(await probe("modal-backdrop.html")).toEqual({ reachable: ["button"], occluded: ["link"], unknown: [] });
  });

  it("reads an input's name from `value`, so the modal submit is not nameless", async () => {
    expect(await probe("input-submit.html")).toEqual({ reachable: ["button"], occluded: ["link"], unknown: [] });
  });

  it("treats a target below the fold as unmeasured, not unreachable", async () => {
    expect(await probe("below-the-fold.html")).toEqual({ reachable: ["link"], occluded: [], unknown: ["button"] });
  });

  it("treats a candidate clipped by its own scroll container as unmeasured", async () => {
    expect(await probe("clipped-in-scroller.html")).toEqual({ reachable: ["link"], occluded: [], unknown: ["button"] });
  });

  it("…and reachable once that container is showing it", async () => {
    expect(await probe("visible-in-scroller.html")).toEqual({
      reachable: ["link", "button"],
      occluded: [],
      unknown: [],
    });
  });

  it("does not call a fixed modal clipped by the scroller it renders inside", async () => {
    expect(await probe("fixed-modal-in-scroller.html")).toEqual({
      reachable: ["button"],
      occluded: ["link"],
      unknown: [],
    });
  });

  it("leaves the scroll container alone — the probe measures, it never scrolls", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.setContent(await readFile(fixture("fixed-modal-in-scroller.html"), "utf8"));
      await page.evaluate(`(${reachableRolesProbeScript("Continue")})()`);
      // Read it as a string expression: this file type-checks under the engine's Node lib, which
      // has no DOM — the page has one.
      expect(await page.evaluate('document.querySelector("main").scrollTop')).toBe(0);
    } finally {
      await page.close();
    }
  });
});
