import { afterEach, describe, expect, it, vi } from "vitest";
import { discover } from "../../../src/core/discover/index.js";
import { observeOutcomes } from "../../../src/core/discover/capture.js";
import type { OutcomeMark } from "../../../src/core/discover/capture.js";
import type { Evidence, NetworkRequest, SettleOptions, Target } from "../../../src/core/types.js";
import { ScriptedLlm, StubDriver } from "../../support/doubles.js";

class DelayedRedirectDriver extends StubDriver {
  readonly requests: NetworkRequest[] = [];
  constructor(readonly redirectMs: number | null = 400, readonly responseMs = 0) {
    super("https://shop/start");
    this.navOn.Signin = "https://shop/signin";
  }
  override async click(target: Target): Promise<void> {
    await super.click(target);
    if (target.text !== "Submit") return;
    const request = { method: "POST", url: "https://shop/api/signin", status: this.responseMs ? 0 : 200 };
    this.requests.push(request);
    if (this.responseMs) setTimeout(() => { request.status = 200; }, this.responseMs);
    if (this.redirectMs !== null) setTimeout(() => { this.url = "https://shop/dashboard"; }, this.redirectMs);
  }
  override async observe(): Promise<Evidence> {
    const evidence = await super.observe();
    return { ...evidence, logic: { ...evidence.logic, requests: this.requests.map((r) => ({ ...r })) } };
  }
}

function discoverSignin(driver: DelayedRedirectDriver) {
  return discover("sign in", {
    driver,
    llm: new ScriptedLlm([
      '{"action":"click","text":"Signin"}',
      '{"action":"click","text":"Submit"}',
      '{"action":"done","assertions":[{"kind":"request-status","urlIncludes":"/api/signin","status":200}]}',
      "[]",
    ]),
  });
}

describe("discovery observes bounded post-response redirects (#203)", () => {
  afterEach(() => vi.useRealTimers());

  it("freezes a redirect 400ms after POST 200 as the actual unmarked destination", async () => {
    vi.useFakeTimers();
    const found = discoverSignin(new DelayedRedirectDriver());
    await vi.advanceTimersByTimeAsync(600);
    const scenario = await found;
    expect(scenario.assertions.find((a) => a.kind === "navigated")).toEqual({
      kind: "navigated", to: "shop/dashboard", origin: "derived",
    });
    expect(scenario.steps[1]?.expect).toEqual({ url: "shop/dashboard" });
    expect(scenario.assertions).toContainEqual({
      kind: "request-status", urlIncludes: "shop/api/signin", status: 200, method: "POST", origin: "derived",
    });
  });

  it("continues through a query/hash-only progress update until the destination changes", async () => {
    vi.useFakeTimers();
    class ProgressDriver extends DelayedRedirectDriver {
      override async click(target: Target): Promise<void> {
        await super.click(target);
        if (target.text === "Submit") this.url += "?loading=true#progress";
      }
    }
    const found = discoverSignin(new ProgressDriver());
    await vi.advanceTimersByTimeAsync(600);
    expect((await found).assertions.find((a) => a.kind === "navigated")).toEqual({
      kind: "navigated", to: "shop/dashboard", origin: "derived",
    });
  });

  it("continues after an in-flight POST resolves before its delayed redirect", async () => {
    vi.useFakeTimers();
    const found = discoverSignin(new DelayedRedirectDriver(600, 200));
    await vi.advanceTimersByTimeAsync(800);
    const scenario = await found;
    expect(scenario.assertions.find((a) => a.kind === "navigated")).toMatchObject({ to: "shop/dashboard" });
    expect(scenario.assertions.find((a) => a.kind === "navigated")).not.toHaveProperty("observedBeforeLastMutation");
  });

  it.each([4_000, null])("returns a marked destination at 2s when redirect delay is %s (null = on-page save)", async (delay) => {
    vi.useFakeTimers();
    const driver = new DelayedRedirectDriver(delay);
    let settled = false;
    const found = discoverSignin(driver).then((scenario) => { settled = true; return scenario; });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const scenario = await found;
    expect(scenario.assertions.find((a) => a.kind === "navigated")).toMatchObject({
      to: "shop/signin", observedBeforeLastMutation: true,
    });
    expect(scenario.steps[1]?.expect).toEqual({
      requestStatus: { urlIncludes: "shop/api/signin", status: 200, method: "POST" },
    });
  });
});

describe("outcome observation budget and request attribution", () => {
  afterEach(() => vi.useRealTimers());
  const mark: OutcomeMark = { url: "https://shop/signin", requestCount: 0 };
  const post = { method: "POST", url: "https://shop/api/signin", status: 200 };

  class ObservationDriver extends StubDriver {
    readonly timeouts: number[] = [];
    constructor(readonly requests: NetworkRequest[] = [post]) { super("https://shop/signin"); }
    override async settle(options?: SettleOptions): Promise<void> {
      this.timeouts.push(options?.timeoutMs ?? -1);
    }
    override async observe(): Promise<Evidence> {
      const evidence = await super.observe();
      return { ...evidence, logic: { ...evidence.logic, requests: this.requests } };
    }
  }

  it.each([
    { name: "read", request: { ...post, method: "GET" }, marks: [mark], first: 0, benign: [] },
    { name: "third-party", request: { ...post, url: "https://telemetry.test/post" }, marks: [mark], first: 0, benign: [] },
    { name: "consumer-benign", request: post, marks: [mark], first: 0, benign: ["/api/signin"] },
    { name: "failed", request: { ...post, status: 500 }, marks: [mark], first: 0, benign: [] },
    { name: "entry", request: post, marks: [{ ...mark, requestCount: 1 }], first: 1, benign: [] },
    { name: "no-action", request: post, marks: [], first: 1, benign: [] },
  ])("does not delay for $name traffic", async ({ request, marks, first, benign }) => {
    vi.useFakeTimers();
    const driver = new ObservationDriver([request]);
    const started = Date.now();
    await observeOutcomes(driver, first, marks, benign);
    expect(Date.now() - started).toBe(0);
    expect(driver.timeouts).toEqual([2_000]);
  });

  it("preserves the pending watermark even for traffic excluded from successful-mutation waiting", async () => {
    vi.useFakeTimers();
    const driver = new ObservationDriver([{ ...post, url: "https://telemetry.test/post", status: 0 }]);
    const done = observeOutcomes(driver, 0, [mark]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await done).logic.requests[0]?.status).toBe(0);
    expect(driver.timeouts).toEqual([2_000, 1_800, 1_600, 1_400, 1_200, 1_000, 800, 600, 400, 200]);
  });

  it("a trailing non-mutation step does not erase the mutation boundary", async () => {
    vi.useFakeTimers();
    const driver = new ObservationDriver();
    setTimeout(() => { driver.url = "https://shop/dashboard"; }, 400);
    const done = observeOutcomes(driver, 0, [null, mark, { ...mark, requestCount: 1 }]);
    await vi.advanceTimersByTimeAsync(600);
    expect((await done).execution.finalUrl).toBe("https://shop/dashboard");
  });

  it("uses only the latest qualifying mutation-bearing step's pre-URL", async () => {
    vi.useFakeTimers();
    const driver = new ObservationDriver([post, post]);
    const done = observeOutcomes(driver, 0, [mark, { url: "https://shop/other", requestCount: 1 }]);
    expect((await done).execution.finalUrl).toBe("https://shop/signin");
    expect(driver.timeouts).toEqual([2_000]);
  });

  it("settles and reobserves a changed destination within the remaining budget", async () => {
    vi.useFakeTimers();
    class LandingDriver extends ObservationDriver {
      override async settle(options?: SettleOptions): Promise<void> {
        await super.settle(options);
        if (this.url.endsWith("dashboard")) this.requests.push({ method: "GET", url: "https://shop/api/profile", status: 200 });
      }
    }
    const driver = new LandingDriver([{ ...post }]);
    setTimeout(() => { driver.url = "https://shop/dashboard"; }, 400);
    const done = observeOutcomes(driver, 0, [mark]);
    await vi.advanceTimersByTimeAsync(600);
    expect((await done).logic.requests).toContainEqual({ method: "GET", url: "https://shop/api/profile", status: 200 });
    expect(driver.timeouts).toEqual([2_000, 1_800, 1_600, 1_400]);
  });

  it("does not restart the budget when a pending mutation succeeds near the deadline", async () => {
    vi.useFakeTimers();
    const request = { ...post, status: 0 };
    const driver = new ObservationDriver([request]);
    setTimeout(() => { request.status = 200; }, 1_900);
    const done = observeOutcomes(driver, 0, [mark]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await done).logic.requests[0]?.status).toBe(200);
    expect(driver.timeouts.at(-1)).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps sleeps after a slow settle and takes the final observation without another settle", async () => {
    vi.useFakeTimers();
    class SlowDriver extends ObservationDriver {
      override async settle(options?: SettleOptions): Promise<void> {
        await super.settle(options);
        await new Promise((resolve) => setTimeout(resolve, 1_950));
      }
    }
    const driver = new SlowDriver();
    const done = observeOutcomes(driver, 0, [mark]);
    await vi.advanceTimersByTimeAsync(2_000);
    await done;
    expect(driver.timeouts).toEqual([2_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("yields bounded polls while the URL keeps changing instead of starving timers", async () => {
    vi.useFakeTimers();
    const driver = new ObservationDriver();
    let changes = 0;
    const ticker = setInterval(() => { driver.url = `https://shop/progress-${++changes}`; }, 100);
    const done = observeOutcomes(driver, 0, [mark]);
    await vi.advanceTimersByTimeAsync(2_000);
    const evidence = await done;
    expect(changes).toBe(20);
    expect(evidence.execution.finalUrl).toBe("https://shop/progress-20");
    expect(driver.timeouts).toHaveLength(10);
    clearInterval(ticker);
    expect(vi.getTimerCount()).toBe(0);
  });
});
