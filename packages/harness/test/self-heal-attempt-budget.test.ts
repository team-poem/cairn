// file: packages/harness/test/self-heal-attempt-budget.test.ts
import { expect, test, vi } from "vitest";
import { StubDriver } from "./support/doubles.js";
import { SelfHealingDriver } from "../src/adapters/drivers/self-heal.js";
import type { Target } from "../src/core/types.js";

function repairFixture(reply = '{"name":"Save"}') {
  const inner = new StubDriver();
  inner.els = [{ role: "button", name: "Save" }];
  const dispatch = vi.spyOn(inner, "click").mockImplementation(async (target: Target) => {
    if (target.text === "Old save") throw new Error("original target missing");
  });
  const complete = vi.fn(async () => reply);
  const onHeal = vi.fn();
  return { inner, dispatch, complete, llm: { id: "budget-test", complete }, onHeal };
}

test("healFailedRetryConsumesBudget: failed repaired dispatch consumes the only model attempt", async () => {
  const f = repairFixture();
  f.dispatch.mockRejectedValue(new Error("dispatch failed"));
  const driver = new SelfHealingDriver(f.inner, f.llm, { maxHeals: 1, onHeal: f.onHeal });
  await expect(driver.click({ text: "Old save" })).rejects.toThrow("dispatch failed");
  expect(f.dispatch).toHaveBeenCalledTimes(2);
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(driver.heals).toEqual([]);
  expect(f.onHeal).not.toHaveBeenCalled();
  await expect(driver.click({ text: "Old save" })).rejects.toThrow(/budget.*exhausted/);
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.dispatch).toHaveBeenCalledTimes(3);
  expect(driver.heals).toEqual([]);
  expect(f.onHeal).not.toHaveBeenCalled();
});

test("healModelFailureConsumesBudget: rejected model request cannot be retried beyond maxHeals", async () => {
  const f = repairFixture();
  f.complete.mockRejectedValue(new Error("model unavailable"));
  const driver = new SelfHealingDriver(f.inner, f.llm, { maxHeals: 1, onHeal: f.onHeal });
  await expect(driver.click({ text: "Old save" })).rejects.toThrow("model unavailable");
  await expect(driver.click({ text: "Old save" })).rejects.toThrow(/budget.*exhausted/);
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(driver.heals).toEqual([]);
  expect(f.onHeal).not.toHaveBeenCalled();
});

test("healMalformedReplyConsumesBudget: unparseable model response consumes an attempt", async () => {
  const f = repairFixture("not JSON");
  const driver = new SelfHealingDriver(f.inner, f.llm, { maxHeals: 1, onHeal: f.onHeal });
  await expect(driver.click({ text: "Old save" })).rejects.toThrow(/no JSON/);
  await expect(driver.click({ text: "Old save" })).rejects.toThrow(/budget.*exhausted/);
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(driver.heals).toEqual([]);
  expect(f.onHeal).not.toHaveBeenCalled();
});

test("healNoMatchConsumesBudget: a model response selecting no match consumes an attempt", async () => {
  const f = repairFixture('{"name":null}');
  const driver = new SelfHealingDriver(f.inner, f.llm, { maxHeals: 1, onHeal: f.onHeal });
  await expect(driver.click({ text: "Old save" })).rejects.toThrow(/no match/);
  await expect(driver.click({ text: "Old save" })).rejects.toThrow(/budget.*exhausted/);
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(driver.heals).toEqual([]);
  expect(f.onHeal).not.toHaveBeenCalled();
});

test("healPolicyRejectionConsumesBudget: denied model repair consumes an attempt without dispatching", async () => {
  const f = repairFixture();
  const driver = new SelfHealingDriver(f.inner, f.llm, {
    maxHeals: 1, onHeal: f.onHeal,
    policy: { vet: () => ({ ok: false, reason: "repair forbidden" }) },
  });
  await expect(driver.click({ text: "Old save" })).rejects.toThrow(/repair forbidden/);
  expect(f.dispatch).toHaveBeenCalledTimes(1);
  await expect(driver.click({ text: "Old save" })).rejects.toThrow(/budget.*exhausted/);
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.dispatch).toHaveBeenCalledTimes(2);
  expect(driver.heals).toEqual([]);
  expect(f.onHeal).not.toHaveBeenCalled();
});

test("healEnrichmentFailureConsumesBudget: locator enrichment failure consumes the model attempt", async () => {
  const f = repairFixture();
  vi.spyOn(f.inner, "locate").mockRejectedValue(new Error("replacement disappeared"));
  const driver = new SelfHealingDriver(f.inner, f.llm, { maxHeals: 1, onHeal: f.onHeal });
  await expect(driver.click({ text: "Old save" })).rejects.toThrow("replacement disappeared");
  await expect(driver.click({ text: "Old save" })).rejects.toThrow(/budget.*exhausted/);
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.dispatch).toHaveBeenCalledTimes(2);
  expect(driver.heals).toEqual([]);
  expect(f.onHeal).not.toHaveBeenCalled();
});
