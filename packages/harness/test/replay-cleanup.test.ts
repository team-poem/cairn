import { describe, expect, it, vi } from "vitest";
import { identifyScenario } from "../src/core/contract.js";
import { EvidenceCaptureSession } from "../src/core/evidence-capture.js";
import { applyReplayCleanup, prepareReplayCleanup, recordReplayCleanup } from "../src/core/replay-cleanup.js";
import { SelectedItemEvidenceSession, type SelectedItemBinding } from "../src/core/selected-item-evidence.js";
import type { Scenario, Step, Target } from "../src/core/types.js";

const target = (): Target => ({ role: "button", text: "Show details" });
const click = (t = target()): Step => ({ kind: "click", target: t });
const start = (): Step => ({ kind: "goto", url: "https://app.test/details" });
const baseline = await identifyScenario({
  name: "Show details", steps: [], assertions: [{ kind: "navigated", to: "/details" }],
} satisfies Scenario, { intent: "Show details" });
const scenario = (steps: Step[] = [start(), click(), click()]): Scenario => ({ ...structuredClone(baseline), steps });
const declares = (repeatIndex = 2) => ({
  semantics: "idempotent-click" as const, revision: "show-v1", scope: "details-dialog", target: target(), repeatIndex,
});

async function approve(source: Scenario, declaration = declares()) {
  const recording = await recordReplayCleanup(source);
  const approval = await prepareReplayCleanup(source, recording, declaration);
  if (approval.status !== "approved") throw new Error(`Expected an approval: ${JSON.stringify(approval)}`);
  return { approval, declaration };
}

describe("terminal repeated click cleanup (#354)", () => {
  it("can omit only the final repeat, preserving the other occurrences and the judgment inputs", async () => {
    const source = scenario([start(), click(), click(), click()]);
    source.provenance = { appContextHash: "a".repeat(64) };
    const original = structuredClone(source);
    const { approval, declaration } = await approve(source, declares(3));
    const onDecision = vi.fn();
    const plan = await applyReplayCleanup(source, { approval: JSON.parse(JSON.stringify(approval)), declaration, onDecision });

    expect(plan).toEqual({ ...original, steps: original.steps.slice(0, 3) });
    expect(approval.mapping.removedIndex).toBe(3);
    expect(source).toEqual(original);
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(plan.steps[1]).not.toBe(source.steps[1]);
    expect(plan.assertions[0]).not.toBe(source.assertions[0]);
    expect(plan.provenance).not.toBe(source.provenance);
  });

  it("a decision listener cannot rewrite the chosen plan through its original references", async () => {
    const source = scenario();
    const expected = structuredClone(source);
    expected.steps.pop();
    const options = await approve(source);
    const onDecision = vi.fn(() => {
      source.steps[1] = { kind: "pressKey", key: "Escape" };
      source.assertions[0] = { kind: "no-console-errors" };
      options.approval.mapping.removedIndex = 0;
      options.declaration.target.text = "Delete";
    });
    const plan = await applyReplayCleanup(source, { ...options, onDecision });
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(plan).toEqual(expected);
  });

  it.each(["toggle", "increment", "set focus", "schedule a delayed update", "unknown effect"])(
    "does not infer idempotence from identical targets or intent: %s", async effect => {
      const t = { text: "Apply", role: "button" };
      const source = scenario([start(), { ...click(t), intent: effect }, { ...click(t), intent: effect }]);
      const recording = await recordReplayCleanup(source);
      expect(recording.status).toBe("recorded");
      expect(await prepareReplayCleanup(source, recording)).toEqual({ status: "declined", reason: "missing-declaration" });
    },
  );

  it.each<[string, Step[]]>([
    ["a different preceding target", [start(), click({ text: "Close details" }), click()]],
    ["an intervening action", [start(), click(), { kind: "pressKey", key: "Tab" }, click()]],
    ["a nonterminal duplicate", [start(), click(), click(), { kind: "pressKey", key: "Tab" }]],
    ["a double click", [start(), click(), { kind: "doubleClick", target: target() }]],
    ["a wait after the retained click", [start(), { ...click(), expect: { text: "Ready" } }, click()]],
    ["a wait after the candidate click", [start(), click(), { ...click(), expect: { text: "Ready" } }]],
  ])("declines %s even with a declaration", async (_case, steps) => {
    const source = scenario(steps);
    expect((await prepareReplayCleanup(source, await recordReplayCleanup(source), declares(steps.length - 1))).status)
      .toBe("declined");
  });

  it.each(["incomplete-recording", "protected-discovery", "incomplete-discovery"] as const)(
    "a recording marked %s cannot authorize cleanup", async reason => {
      const source = scenario();
      const recording = await recordReplayCleanup(source, reason);
      expect(recording.status).toBe("unavailable");
      expect((await prepareReplayCleanup(source, recording, declares())).status).toBe("declined");
    },
  );

  it.each(["action-dispatch-uncertain", "action-no-progress", "selection-unproven"] as const)(
    "does not optimize the confirmed prefix of an incomplete recording: %s", async truncationReason => {
      const source = { ...scenario(), truncated: true, truncationReason };
      expect((await prepareReplayCleanup(source, await recordReplayCleanup(source), declares())).status).toBe("declined");
    },
  );

  it("cannot reuse approval after the host changes the meaning, scope, locator or occurrence", async () => {
    const source = scenario();
    const { approval, declaration } = await approve(source);
    for (const edit of [{ revision: "show-v2" }, { scope: "edit-dialog" }, { target: { ...target(), role: "link" } }, { repeatIndex: 1 }]) {
      expect(await applyReplayCleanup(source, { approval, declaration: { ...declaration, ...edit } })).toBe(source);
    }
  });

  it("checks the approved source again, including assertions and step metadata", async () => {
    const source = scenario();
    const recording = await recordReplayCleanup(source);
    const options = await approve(source);
    for (const changed of [
      scenario([{ kind: "goto", url: "https://app.test/elsewhere" }, click(), click()]),
      scenario([start(), click(), { ...click(), intent: "a different intent" }]),
      { ...source, assertions: [{ kind: "no-console-errors" as const }] },
    ]) {
      expect((await prepareReplayCleanup(changed, recording, options.declaration)).status).toBe("declined");
      expect(await applyReplayCleanup(changed, options)).toBe(changed);
    }
  });

  it("rejects edits to the approval's mapping and fingerprints, even for the unchanged source", async () => {
    const source = scenario();
    const { approval, declaration } = await approve(source);
    for (const changed of [
      { ...approval, mapping: { ...approval.mapping, removedIndex: 1 } },
      { ...approval, planFingerprint: "0".repeat(64) },
      { ...approval, sourceFingerprint: "0".repeat(64) },
      { ...approval, declarationFingerprint: "0".repeat(64) },
    ]) expect(await applyReplayCleanup(source, { approval: changed, declaration })).toBe(source);
  });

  it("checks the current judge configuration before using an approved path", async () => {
    const judgment = { judgmentKey: "details-v1" };
    const source = await identifyScenario(scenario(), { ...judgment, intent: "show details" });
    const options = await approve(source);
    expect((await applyReplayCleanup(source, options, { judgment })).steps).toEqual(source.steps.slice(0, 2));
    for (const changed of [{ judgmentKey: "details-v2" }, { ...judgment, benign: ["/newly-ignored-error"] }]) {
      const onDecision = vi.fn();
      expect(await applyReplayCleanup(source, { ...options, onDecision }, { judgment: changed })).toBe(source);
      expect(onDecision).toHaveBeenCalledWith({ status: "declined", reason: "stale-approval" });
    }
  });

  it("does not issue an unusable approval when appended checks still have the discovery stamp or an incomplete stamp", async () => {
    const source = scenario(), recording = await recordReplayCleanup(source);
    source.assertions.push({ kind: "custom", name: "reviewed" });
    for (const candidate of [source, { ...source, contract: undefined }, await identifyScenario(source)])
      expect(await prepareReplayCleanup(candidate, recording, declares())).toEqual({ status: "declined", reason: "unidentified-judgment" });
    const restamped = await identifyScenario(source, { judgmentKey: "review-v1" });
    expect((await prepareReplayCleanup(restamped, recording, declares())).status).toBe("approved");
  });

  it("cannot move a declaration fingerprint between two otherwise valid approvals", async () => {
    const source = scenario();
    const original = await approve(source);
    const other = scenario([{ kind: "goto", url: "https://app.test/other" }, click(), click()]);
    const otherOptions = await approve(other, { ...declares(), revision: "show-v2" });
    const mixed = { ...original.approval, declarationFingerprint: otherOptions.approval.declarationFingerprint };
    expect(await applyReplayCleanup(source, { approval: mixed, declaration: otherOptions.declaration })).toBe(source);
  });

  it("uses the plan snapshotted on entry even when caller-owned inputs change during hashing", async () => {
    const source = scenario();
    const expected = structuredClone(source);
    expected.steps.pop();
    const options = await approve(source);
    const deciding = applyReplayCleanup(source, options);
    source.steps[1] = { kind: "pressKey", key: "Escape" };
    source.assertions[0] = { kind: "no-console-errors" };
    options.approval.planFingerprint = "0".repeat(64);
    options.declaration.target.text = "Delete";
    expect(await deciding).toEqual(expected);
  });

  it("preserves a replay checkpoint after the final click; a checkpoint after the retained click still fits", async () => {
    const source = scenario();
    const options = await approve(source);
    const onCapture = vi.fn();
    const protect = (after: Step[]) => new EvidenceCaptureSession({ onCapture, checkpoints: [{ id: "details", after, elements: true }] }, "replay");
    expect(await applyReplayCleanup(source, options, protect(source.steps))).toBe(source);
    expect((await applyReplayCleanup(source, options, protect(source.steps.slice(0, 2)))).steps).toEqual(source.steps.slice(0, 2));
    expect(onCapture).not.toHaveBeenCalled();
  });

  it("cannot move the destination read for a resource selected earlier in the replay", async () => {
    const select: Step = { kind: "click", target: { collection: {
      root: { role: "list", name: "Documents" }, itemRole: "listitem", target: { role: "button", name: "Open" }, order: "dom", index: 0,
    } } };
    const source = scenario([select, click(), click()]);
    const options = await approve(source);
    const binding: SelectedItemBinding = { version: 1, id: "detail", relation: "resource-key-equals", phase: "replay",
      source: { after: [select], key: { kind: "attribute", scope: "item", attribute: "data-key" } },
      destination: { after: source.steps, key: { kind: "attribute", selector: "#detail", attribute: "data-key" } } };
    const session = new SelectedItemEvidenceSession({ bindings: [binding] });
    expect(await applyReplayCleanup(source, options, { protectedPrefixLength: session.protectedPrefixLength })).toBe(source);
  });

  it("declines oversized input, even when the two terminal actions are eligible", async () => {
    const source = scenario(Array.from({ length: 1001 }, () => click()));
    const recording = await recordReplayCleanup(source);
    expect(recording.status).toBe("unavailable");
    expect((await prepareReplayCleanup(source, recording, declares(1000))).status).toBe("declined");
  });

  it("does not read a getter in custom assertion parameters to fingerprint or approve the recording", async () => {
    const source = scenario();
    const read = vi.fn(() => "opens-the-browser");
    source.assertions.push({ kind: "custom", name: "dynamic-check", params: Object.defineProperty({}, "value", { enumerable: true, get: read }) });
    const recording = await recordReplayCleanup(source);
    expect(recording.status).toBe("unavailable");
    expect((await prepareReplayCleanup(source, recording, declares())).status).toBe("declined");
    expect(read).not.toHaveBeenCalled();
  });
});
