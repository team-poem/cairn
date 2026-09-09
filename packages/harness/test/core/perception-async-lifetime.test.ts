import { expect, it } from "vitest";
import { StubDriver } from "../support/doubles.js";
import { PerceptionObservation } from "../../src/core/observation.js";
import { applyDecision } from "../../src/core/discover/decision.js";
import { SelfHealingDriver } from "../../src/adapters/drivers/self-heal.js";
import type { PageElement, Target } from "../../src/core/types.js";

const rows: PageElement[] = [{ role: "textbox", name: "Password", ref: "same-live-node" }];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
const token = (text: string) => text.match(/ref="([^"]+)"/)![1]!;
class ExactDriver extends StubDriver {
  dispatched: string[] = [];
  async locateRef(): Promise<Target> { return { text: "Password", role: "textbox", selector: "#password" }; }
  override async click(target: Target) { if (target.text === "Old") throw new Error("missing"); this.dispatched.push("click"); }
  override async type() { this.dispatched.push("type"); }
  override async snapshot() { return rows; }
}

it("ref decision superseded while locateRef awaits cannot dispatch a still-live backend node", async () => {
  const entered = deferred(), release = deferred();
  class DelayedLocator extends ExactDriver {
    override async locateRef() { entered.resolve(); await release.promise; return super.locateRef(); }
  }
  const driver = new DelayedLocator();
  const first = new PerceptionObservation(driver, rows, rows, "fill");
  const execution = applyDecision(driver, first.bind({ action: "click", ref: token(first.references) }));
  await entered.promise;
  new PerceptionObservation(driver, rows, rows, "fill");
  release.resolve();
  await expect(execution).rejects.toThrow(/expired/);
  expect(driver.dispatched).toEqual([]);
});

it("scoped type revalidates observation after awaiting the page origin", async () => {
  const entered = deferred(), release = deferred();
  class DelayedOrigin extends ExactDriver {
    override async observe() { entered.resolve(); await release.promise; return super.observe(); }
  }
  const driver = new DelayedOrigin();
  const first = new PerceptionObservation(driver, rows, rows, "fill");
  const execution = applyDecision(driver, first.bind({ action: "type", ref: token(first.references), value: "{password}" }), { password: { value: "private", origin: "https://app" } });
  await entered.promise;
  new PerceptionObservation(driver, rows, rows, "fill");
  release.resolve();
  await expect(execution).rejects.toThrow(/expired/);
  expect(driver.dispatched).toEqual([]);
});

it("locator heal superseded during enrichment cannot dispatch or record a successful substitution", async () => {
  const entered = deferred(), release = deferred();
  class DelayedLocator extends ExactDriver {
    override async locateRef() { entered.resolve(); await release.promise; return super.locateRef(); }
  }
  const driver = new DelayedLocator();
  const healer = new SelfHealingDriver(driver, { id: "ref", complete: async prompt => JSON.stringify({ ref: token(prompt) }) });
  const execution = healer.click({ text: "Old" });
  await entered.promise;
  new PerceptionObservation(driver, rows, rows, "fill");
  release.resolve();
  await expect(execution).rejects.toThrow(/expired/);
  expect(driver.dispatched).toEqual([]);
  expect(healer.heals).toEqual([]);
});

it("a decision description changed during locator enrichment cannot reach dispatch", async () => {
  const entered = deferred(), release = deferred();
  class DelayedLocator extends ExactDriver {
    override async locateRef() { entered.resolve(); await release.promise; return super.locateRef(); }
  }
  const driver = new DelayedLocator();
  const page = new PerceptionObservation(driver, rows, rows, "fill");
  const decision = page.bind({ action: "click", ref: token(page.references) });
  const execution = applyDecision(driver, decision);
  await entered.promise;
  decision.text = "Different";
  release.resolve();
  await expect(execution).rejects.toThrow(/changed/);
  expect(driver.dispatched).toEqual([]);
});
