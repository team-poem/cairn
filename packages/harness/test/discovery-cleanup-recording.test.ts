import { expect, it } from "vitest";
import { discover as ordinaryDiscovery, discoverForReplayCleanup, type DiscoverOptions, type Evidence, type LlmClient, type PageElement, type Target } from "../src/index.js";
import { StubDriver } from "./support/doubles.js";

type Behavior = "stable" | "late row" | "late GET" | "pending GET" | "lost receipt" | "replaced node"
  | "toggle" | "unavailable snapshot" | "abort final read" | "always unchanged";

// The first Show opens the panel. The ordinary repeat leaves it open; individual cases
// change just one fact used to distinguish an observed repeat from an unknown effect.
class Panel extends StubDriver {
  proposed = false;
  finalReads = 0;
  readonly controller = new AbortController();
  open = false;
  private beforeClick?: (id: string | undefined) => void;
  private receipt?: string;
  constructor(readonly behavior: Behavior) { super(); }

  override async snapshot(): Promise<PageElement[]> {
    if (this.proposed) {
      this.finalReads++;
      if (this.behavior === "abort final read") this.controller.abort(new Error("cancel final read"));
      if (this.behavior === "unavailable snapshot" || this.controller.signal.aborted) throw new Error("snapshot unavailable");
    }
    return [{ role: "button", name: "Show" }, { role: "heading", name: this.open ? "Details" : "List" },
      ...(this.proposed && this.behavior === "late row" ? [{ role: "status", name: "Another result" }] : [])];
  }

  override async observe(): Promise<Evidence> {
    const result = await super.observe();
    if (this.behavior === "pending GET" || this.proposed && this.behavior === "late GET")
      result.logic.requests.push({ method: "GET", url: `${this.url}/details`, status: this.behavior === "pending GET" ? 0 : 200 });
    return result;
  }

  armActionOutcomeIdentity(check?: (id: string | undefined) => void) { this.beforeClick = check; }
  takeActionOutcomeIdentity() {
    const receipt = this.receipt;
    this.beforeClick = this.receipt = undefined;
    return receipt;
  }
  override async click(target: Target) {
    const isRepeat = this.clicked.length > 0;
    const node = this.behavior === "replaced node" && isRepeat ? "different-button" : "panel-button";
    this.beforeClick?.(node);
    await super.click(target);
    this.receipt = this.behavior === "lost receipt" && isRepeat ? undefined : node;
    this.open = this.behavior === "toggle" ? !this.open : this.behavior !== "always unchanged";
  }
}

function discover(driver: Panel, clicks = 2, perceive?: DiscoverOptions["perceive"]) {
  let turns = 0;
  const llm: LlmClient = { id: "panel", async complete(prompt) {
    if (prompt.includes("Propose the verification assertions.")) { driver.proposed = true; return "[]"; }
    return JSON.stringify(turns++ < clicks ? { action: "click", role: "button", text: "Show" } : { action: "done" });
  } };
  return discoverForReplayCleanup("Show details", { driver, llm, baseUrl: driver.url, signal: driver.controller.signal, perceive });
}

it.each<Behavior>(["stable", "late row", "late GET", "pending GET", "lost receipt", "replaced node", "toggle", "unavailable snapshot"])(
  "always returns the original trail; only a stable acknowledged repeat is a cleanup candidate: %s", async behavior => {
    const driver = new Panel(behavior);
    const { scenario, recording } = await discover(driver);
    expect(scenario.truncated).not.toBe(true);
    expect(scenario.steps.map(step => step.kind)).toEqual(["goto", "click", "click"]);
    expect(driver.clicked).toEqual(["Show", "Show"]);
    expect(recording.status).toBe(behavior === "stable" ? "recorded" : "unavailable");
    if (["stable", "late row", "late GET", "unavailable snapshot"].includes(behavior)) expect(driver.finalReads).toBe(1);
  },
);

it("still rejects caller cancellation during the optional final read", async () => {
  const driver = new Panel("abort final read");
  await expect(discover(driver)).rejects.toThrow("cancel final read");
  expect(driver.finalReads).toBe(1);
  expect(driver.clicked).toEqual(["Show", "Show"]);
});

it("never freezes a possibly sent input's navigation as an expect on the preceding click", async () => {
  const driver = new class extends Panel {
    override async click(target: Target) {
      await super.click(target);
      if (this.clicked.length === 2) { this.url += "/after-uncertain-click"; throw new Error("lost acknowledgement"); }
    }
  }("stable");
  const { recording, scenario } = await discover(driver);
  expect(scenario.truncationReason).toBe("click-dispatch-uncertain");
  expect(scenario.steps.map(s => [s.kind, s.expect])).toEqual([["goto", undefined], ["click", undefined]]);
  expect(driver.clicked).toEqual(["Show", "Show"]);
  expect(recording.status).toBe("unavailable");
});

it("does not introduce a repeat limit when only recording was requested", async () => {
  const driver = new Panel("always unchanged");
  const { scenario, recording } = await discover(driver, 4);
  expect(driver.clicked).toEqual(["Show", "Show", "Show", "Show"]);
  expect(scenario.steps).toHaveLength(5);
  expect(scenario.truncated).not.toBe(true);
  expect(recording.status).toBe("unavailable");
});

it("preserves the original freeze interval for a late POST, with and without an explicit outcome policy", async () => {
  async function run(record: boolean, explicit: boolean) {
    let sent = false;
    const driver = new class extends Panel {
      override async observe() {
        const evidence = await super.observe();
        if (sent) evidence.logic.requests.push({ method: "POST", url: this.url + "/submit-order", status: 200 });
        return evidence;
      }
    }("stable");
    const llm = { id: "late response", async complete(prompt: string) {
      if (prompt.includes("Propose the verification assertions.")) return "[]";
      if (!driver.clicked.length) return '{"action":"click","text":"Show","role":"button"}';
      sent = true;
      return '{"action":"done"}';
    } };
    const opts = { driver, llm, ...(explicit && { actionOutcomes: {} }) };
    return record ? (await discoverForReplayCleanup("Submit order", opts)).scenario : ordinaryDiscovery("Submit order", opts);
  }
  await Promise.all([false, true].map(async explicit => {
    const [normal, recorded] = await Promise.all([run(false, explicit), run(true, explicit)]);
    expect(recorded.steps).toEqual(normal.steps);
    if (explicit) expect(recorded.steps[0]?.expect).toBeUndefined();
    else expect(recorded.steps[0]?.expect?.requestStatus).toMatchObject({ method: "POST", status: 200 });
  }));
});

it.each(["before first", "before repeat", "between proposals"] as const)(
  "keeps both clicks when the panel changes without a request: %s", async when => {
    const driver = new Panel("stable");
    const click = { action: "click", role: "button", text: "Show" };
    let turns = 0;
    const llm = { id: "timing", async complete(prompt: string) {
      if (prompt.includes("Propose the verification assertions.")) return "[]";
      const turn = turns++;
      if (when === "before first" && turn === 0) driver.open = true;
      if (when === "before repeat" && turn === 1) driver.open = false;
      if (when === "between proposals" && (turn === 1 || turn === 2)) {
        driver.open = turn === 2;
        return "not a decision";
      }
      return JSON.stringify(driver.clicked.length < 2 ? click : { action: "done" });
    } };
    const { recording, scenario } = await discoverForReplayCleanup("Show", { driver, llm });
    expect(driver.clicked).toEqual(["Show", "Show"]);
    expect(scenario.truncated).not.toBe(true);
    expect(recording.status).toBe("unavailable");
  },
);

it("keeps a repeat when the value of another control on the page was never measured", async () => {
  const driver = new class extends Panel {
    override async snapshot() { return [...await super.snapshot(), { role: "checkbox", name: "Include attachments" }]; }
  }("stable");
  const { recording } = await discover(driver);
  expect(driver.clicked).toEqual(["Show", "Show"]);
  expect(recording.status).toBe("unavailable");
});

it.each([false, true])("preserves a raw action-eligibility change even with a host correction: %s", async correct => {
  const driver = new class extends Panel {
    override async snapshot(): Promise<PageElement[]> {
      return [...await super.snapshot(), { role: "button", name: "Edit",
        actions: { click: this.clicked.length < 2 ? "supported" : "disallowed" } }];
    }
  }("stable");
  const { recording } = await discover(driver, 2, correct ? rows => {
    for (const row of rows) if (row.name === "Edit" && row.actions) row.actions.click = "supported";
    return rows;
  } : undefined);
  expect(driver.clicked).toEqual(["Show", "Show"]);
  expect(recording.status).toBe("unavailable");
});

it("does not require driver-private row properties to be serializable", async () => {
  const driver = new class extends Panel {
    override async snapshot() {
      return (await super.snapshot()).map(row => ({ ...row, driverHandle: () => row.name }));
    }
  }("stable");
  const { scenario, recording } = await discover(driver, 2, rows => rows);
  expect(scenario.steps.map(step => step.kind)).toEqual(["goto", "click", "click"]);
  expect(recording.status).toBe("recorded");
});

it.each([{ sizes: [1_000_001] }, { sizes: [500_000, 500_000] }])("stops retaining oversized history without losing executed steps ($sizes)", async ({ sizes }) => {
  const driver = new Panel("stable");
  let turn = 0;
  const llm = { id: "large input", async complete(prompt: string) {
    if (prompt.includes("Propose the verification assertions.")) return "[]";
    const size = sizes[turn++];
    if (size !== undefined) return JSON.stringify({ action: "type", text: "Note", value: "a".repeat(size) });
    return JSON.stringify(driver.clicked.length < 2 ? { action: "click", text: "Show", role: "button" } : { action: "done" });
  } };
  const { scenario, recording } = await discoverForReplayCleanup("Show", { driver, llm });
  expect(scenario.steps.map(s => s.kind === "type" ? s.text.length : s.kind)).toEqual([...sizes, "click", "click"]);
  expect(driver.clicked).toEqual(["Show", "Show"]);
  expect(recording).toMatchObject({ status: "unavailable", reason: "incomplete-recording" });
});

it("keeps normal secret substitution and the original clicks when values cannot be compared unredacted", async () => {
  let filled: string | undefined, turn = 0;
  const driver = new class extends Panel {
    override async type(_target?: Target, value?: string) { filled = value; }
  }("stable");
  const llm = { id: "secret field", async complete(prompt: string) {
    expect(prompt).not.toContain("test-secret-value");
    if (prompt.includes("Propose the verification assertions.")) return "[]";
    if (!turn++) return '{"action":"type","text":"Code","value":"{token}"}';
    return JSON.stringify(driver.clicked.length < 2 ? { action: "click", text: "Show", role: "button" } : { action: "done" });
  } };
  const { scenario, recording } = await discoverForReplayCleanup("Show", { driver, llm, secrets: { token: "test-secret-value" } });
  expect(filled).toBe("test-secret-value");
  expect(scenario.steps[0]).toMatchObject({ kind: "type", text: "{token}" });
  expect(driver.clicked).toEqual(["Show", "Show"]);
  expect(recording).toMatchObject({ status: "unavailable", reason: "protected-discovery" });
});

it.each(["missing", "throws", "available"] as const)("preserves the pending reference when a safe recheck is %s", async mode => {
  let generation = 0, rechecks = 0;
  const driver = new class extends Panel {
    async rows() { return (await super.snapshot()).map((row, i) => ({ ...row, ref: generation + ":" + i })); }
    override async snapshot() { generation++; return this.rows(); }
    snapshotForTask = mode === "missing" ? undefined : async () => {
      rechecks++;
      if (mode === "throws") throw new Error("optional read failed");
      return this.rows();
    };
    async locateRef(ref: string) {
      if (ref !== generation + ":0") throw new Error("reference expired during location");
      return { role: "button", text: "Show" };
    }
    override async click(target: Target, ref?: string) {
      if (ref !== generation + ":0") throw new Error("reference expired before input");
      await super.click(target);
    }
  }("stable");
  const llm = { id: "exact", async complete(prompt: string) {
    if (prompt.includes("Propose the verification assertions.")) return "[]";
    if (driver.clicked.length === 2) return '{"action":"done"}';
    const ref = prompt.match(/ref="([^"]+)" \[button\] Show/)?.[1];
    if (!ref) throw new Error("missing listed button ref");
    return JSON.stringify({action: "click", ref});
  } };
  const { recording, scenario } = await discoverForReplayCleanup("Show", { driver, llm });
  expect(scenario.truncated).not.toBe(true);
  expect(driver.clicked).toEqual(["Show", "Show"]);
  expect(rechecks).toBe(mode === "missing" ? 0 : 2);
  expect(recording.status).toBe(mode === "available" ? "recorded" : "unavailable");
});
