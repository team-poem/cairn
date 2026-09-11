// file: packages/harness/test/chrome-snapshot-consistency.test.ts
import { expect, test } from "vitest";
import { ChromeDevToolsDriver } from "../src/adapters/drivers/chrome.js";
import { applyDecision } from "../src/core/discover/decision.js";
import { BuiltinStepHandler } from "../src/core/steps.js";
import type { Step, Target } from "../src/core/types.js";

type SnapshotFixture = {
  compact: string;
  verbose: string;
  openCompact?: string;
  openVerbose?: string;
  openerUid?: string;
};

function chromeSnapshotFixture(tree: SnapshotFixture) {
  const driver = new ChromeDevToolsDriver({ promoteClickables: false });
  const clicks: string[] = [];
  let opened = false;
  (driver as unknown as { call: unknown }).call = async (name: string, args: Record<string, unknown> = {}) => {
    if (name === "take_snapshot") {
      return args.verbose
        ? (opened ? tree.openVerbose ?? tree.verbose : tree.verbose)
        : (opened ? tree.openCompact ?? tree.compact : tree.compact);
    }
    if (name === "list_pages") return "0: https://example.test/form [selected]";
    if (name === "evaluate_script") {
      const script = String(args.function);
      if (script.includes("connected:")) return JSON.stringify({ connected: true });
      if (script.includes("const ids =")) {
        return JSON.stringify(Object.fromEntries((args.args as string[]).map(uid => [uid, { referenceReady: true }])));
      }
      if (script.includes("tagName")) return JSON.stringify({ tag: "BUTTON" });
      return "{}";
    }
    if (name === "click") {
      const uid = String(args.uid);
      clicks.push(uid);
      if (uid === tree.openerUid) opened = true;
    }
    return "";
  };
  driver.settle = async () => {};
  return { driver, clicks };
}

const duplicatePoolTree: SnapshotFixture = {
  compact: 'uid=1_2 button "Save"\nuid=1_3 button "Save"',
  verbose: 'uid=1_1 button "Save"\nuid=1_2 button "Save"\nuid=1_3 button "Save"',
};

test("chromeLegacyPerceptionFreezeReplayIdentity: perception capture preserves ordinary roleless nth lookup and fresh replay", async () => {
  const tree: SnapshotFixture = {
    compact: 'uid=1_1 button "Save"\nuid=1_3 button "Save"',
    verbose: 'uid=1_1 button "Save"\n  uid=1_2 StaticText "Save"\nuid=1_3 button "Save"\n  uid=1_4 StaticText "Save"',
  };
  const baseline = chromeSnapshotFixture(tree);
  const ordinaryTarget = await baseline.driver.locate({ text: "Save", nth: 1 });
  expect(ordinaryTarget).toEqual({ text: "Save", role: "button", index: 1, nth: 1 });

  const discovery = chromeSnapshotFixture(tree);
  await discovery.driver.snapshot({ perception: true });
  // A legacy decision without a ref keeps the pre-existing compact lookup semantics.
  const step = await applyDecision(discovery.driver, { action: "click", text: "Save", nth: 1 });
  expect(discovery.clicks).toEqual(["1_3"]);
  expect(step).toMatchObject({ kind: "click", target: ordinaryTarget });
  const frozen = JSON.parse(JSON.stringify(step)) as Step;
  expect(JSON.stringify(frozen)).not.toMatch(/cairn:|1_3/);

  const replay = chromeSnapshotFixture(tree);
  await new BuiltinStepHandler().execute(frozen, replay.driver);
  expect(replay.clicks).toEqual(["1_3"]);
});

test("chromePerceptionSelectWatermark: a verbose-only closed option becomes selectable without choosing an unrelated native option", async () => {
  const closed = 'uid=1_1 combobox "Size"\nuid=1_9 option "Medium"';
  const open = closed + '\nuid=1_2 listbox "Sizes"\nuid=1_3 option "Medium"';
  const { driver, clicks } = chromeSnapshotFixture({
    compact: closed,
    verbose: open,
    openCompact: open,
    openVerbose: open,
    openerUid: "1_1",
  });
  const observed = await driver.snapshot({ perception: true });
  expect(observed.filter(row => row.role === "option" && row.name === "Medium")).toHaveLength(2);

  await driver.select({ text: "Size", role: "combobox" }, "Medium");
  expect(clicks).toEqual(["1_1", "1_3"]);
});

test("chromeReferenceFreezeReplayIdentity: a captured duplicate ref freezes a locator that replays the same node across capture pools", async () => {
  const discovery = chromeSnapshotFixture(duplicatePoolTree);
  const observed = await discovery.driver.snapshot({ perception: true });
  const ref = observed[1]?.ref;
  expect(ref).toBeTypeOf("string");
  const target = await discovery.driver.locateRef(ref!);
  await discovery.driver.click(target, ref!);
  expect(discovery.clicks).toEqual(["1_2"]);

  const frozen = JSON.parse(JSON.stringify(target)) as Target;
  expect(Object.keys(frozen).every(key => ["text", "role", "index", "nth", "selector"].includes(key))).toBe(true);
  expect(JSON.stringify(frozen)).not.toContain(ref!);
  const replay = chromeSnapshotFixture(duplicatePoolTree);
  await replay.driver.click(frozen);
  expect(replay.clicks).toEqual(["1_2"]);
});
