// file: packages/harness/test/chrome-retry-cache.test.ts
import { expect, test } from "vitest";
import { ChromeDevToolsDriver } from "../src/adapters/drivers/chrome.js";
import { applyDecision } from "../src/core/discover/decision.js";
import { BuiltinStepHandler } from "../src/core/steps.js";
import type { Step } from "../src/core/types.js";

function retryChrome(tree: { compact: string; verbose: string; openCompact?: string; openerUid?: string }) {
  const driver = new ChromeDevToolsDriver({ promoteClickables: false });
  const clicks: string[] = [];
  let opened = false;
  (driver as unknown as { call: unknown }).call = async (name: string, args: Record<string, unknown> = {}) => {
    if (name === "take_snapshot") return args.verbose ? tree.verbose : opened ? tree.openCompact ?? tree.compact : tree.compact;
    if (name === "list_pages") return "0: https://example.test/form [selected]";
    if (name === "evaluate_script") return JSON.stringify({ tag: "BUTTON" });
    if (name === "click") {
      clicks.push(String(args.uid));
      if (args.uid === tree.openerUid) opened = true;
    }
    return "";
  };
  driver.settle = async () => {};
  return { driver, clicks };
}

const retryDuplicateTree = {
  compact: 'uid=1_2 button "Save"\nuid=1_3 button "Save"',
  verbose: 'uid=1_1 button "Save"\nuid=1_2 button "Save"\nuid=1_3 button "Save"',
};

test("chromeRetryDiscoveryReplayIdentity: a failed target retry cannot change the next decision's compact ordinal", async () => {
  const discovery = retryChrome(retryDuplicateTree);
  await expect(discovery.driver.click({ text: "Missing", role: "button" })).rejects.toThrow();
  const step = await applyDecision(discovery.driver, { action: "click", text: "Save", role: "button", nth: 1 });
  expect(discovery.clicks).toEqual(["1_3"]);
  const replay = retryChrome(retryDuplicateTree);
  await new BuiltinStepHandler().execute(JSON.parse(JSON.stringify(step)) as Step, replay.driver);
  expect(replay.clicks).toEqual(discovery.clicks);
});
