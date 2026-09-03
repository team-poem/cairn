import { describe, expect, it } from "vitest";
import { discover } from "../../../src/core/discover/index.js";
import { assignStepExpects, destinationKey, freshMutationExpect } from "../../../src/core/discover/capture.js";
import type { Step } from "../../../src/core/types.js";
import { ScriptedLlm, StubDriver } from "../../support/doubles.js";
import { DESTINATION_CHANGE_CORPUS } from "../../support/url-corpus.js";
import type { Evidence, NetworkRequest, Target } from "../../../src/core/types.js";
import { afterEach, vi } from "vitest";
import { observeOutcomes } from "../../../src/core/discover/capture.js";

/** Completed-run evidence with the given final URL and request log (capture is retroactive, #81). */
function evidenceAt(finalUrl: string, requests: NetworkRequest[]): Evidence {
  return {
    execution: { actions: [], navigated: true, finalUrl, blocked: false },
    perception: {},
    logic: { requests, console: [] },
  };
}

describe("discover captures intent + expect", () => {
  it("stores the action reason as intent and a navigation as expect", async () => {
    const driver = new StubDriver();
    driver.navOn["Select"] = "https://app/cart";
    const llm = new ScriptedLlm([
      '{"action":"click","text":"Select","reason":"select the item"}',
      '{"action":"done"}',
    ]);
    const found = await discover("buy", { driver, llm });
    expect(found.steps[0]?.intent).toBe("select the item");
    expect(found.steps[0]?.expect).toEqual({ url: "app/cart" });
  });

  it("captures a fresh successful mutation as a requestStatus expect (async action, no nav)", async () => {
    // A submit that fires a POST but doesn't navigate — the URL-only check missed it; now it's frozen
    // as a requestStatus expect so replay can wait for that request.
    class MutationStub extends StubDriver {
      private submitted = false;
      override async click(t: Target): Promise<void> {
        this.clicked.push(t.text ?? "");
        if (t.text === "Submit") this.submitted = true;
      }
      override async observe(): Promise<Evidence> {
        const requests = this.submitted
          ? [{ method: "POST", url: "https://api.app/v1/orders?x=1", status: 200 }]
          : [];
        return {
          execution: { actions: [], navigated: false, finalUrl: this.url, blocked: false },
          perception: {},
          logic: { requests, console: [] },
        };
      }
    }
    const driver = new MutationStub();
    const llm = new ScriptedLlm([
      '{"action":"click","text":"Submit","reason":"place order"}',
      '{"action":"done"}',
    ]);
    const found = await discover("place an order", { driver, llm });
    expect(found.steps[0]?.expect).toEqual({
      requestStatus: { urlIncludes: "api.app/v1/orders", status: 200, method: "POST" },
    });
  });

  it("freezes a stable path prefix, not a run-specific id segment", async () => {
    class IdMutationStub extends StubDriver {
      private submitted = false;
      override async click(t: Target): Promise<void> {
        this.clicked.push(t.text ?? "");
        if (t.text === "Confirm") this.submitted = true;
      }
      override async observe(): Promise<Evidence> {
        const requests = this.submitted
          ? [{ method: "POST", url: "https://api.app/orders/ord_8f3a2c/confirm", status: 200 }]
          : [];
        return {
          execution: { actions: [], navigated: false, finalUrl: this.url, blocked: false },
          perception: {},
          logic: { requests, console: [] },
        };
      }
    }
    const driver = new IdMutationStub();
    const llm = new ScriptedLlm(['{"action":"click","text":"Confirm"}', '{"action":"done"}']);
    const found = await discover("confirm order", { driver, llm });
    // "ord_8f3a2c" is a fresh id every run — freezing it would never match a later replay.
    expect(found.steps[0]?.expect).toEqual({
      requestStatus: { urlIncludes: "api.app/orders", status: 200, method: "POST" },
    });
  });

  it("a repeated identical mutation still gets an expect (append-only tail, not a seen-set)", async () => {
    class RepeatStub extends StubDriver {
      readonly requests: { method: string; url: string; status: number }[] = [];
      override async click(t: Target): Promise<void> {
        this.clicked.push(t.text ?? "");
        if (t.text === "Add") this.requests.push({ method: "POST", url: "https://api.app/cart", status: 200 });
      }
      override async observe(): Promise<Evidence> {
        return {
          execution: { actions: [], navigated: false, finalUrl: this.url, blocked: false },
          perception: {},
          logic: { requests: [...this.requests], console: [] },
        };
      }
    }
    const driver = new RepeatStub();
    const llm = new ScriptedLlm([
      '{"action":"click","text":"Add"}',
      '{"action":"click","text":"Add"}',
      '{"action":"done"}',
    ]);
    const found = await discover("add two items", { driver, llm });
    // The second POST is identical to the first — it must still freeze this step's post-condition.
    expect(found.steps[1]?.expect).toEqual({
      requestStatus: { urlIncludes: "api.app/cart", status: 200, method: "POST" },
    });
  });

  it("waits out an in-flight mutation at freeze time, then assigns the expect (capture-side race, #81)", async () => {
    // The submit's POST is still pending (status 0) when the loop moves on and resolves only on a
    // later observation — a mid-run snapshot would have frozen NO expect, leaving the step
    // unverifiable at replay. Expects are now decided retroactively at freeze time, where the
    // final (bounded) observation sees the resolved status.
    class SlowResponseStub extends StubDriver {
      private observes = 0;
      private fired = false;
      override async pressKey(): Promise<void> {
        this.fired = true;
      }
      override async observe(): Promise<Evidence> {
        this.observes += 1;
        const status = this.observes > 3 ? 200 : 0; // response lands only on a later observation
        const requests = this.fired
          ? [{ method: "POST", url: "https://api.app/auth/sign-in", status }]
          : [];
        return {
          execution: { actions: [], navigated: false, finalUrl: this.url, blocked: false },
          perception: {},
          logic: { requests, console: [] },
        };
      }
    }
    const driver = new SlowResponseStub();
    const llm = new ScriptedLlm([
      '{"action":"pressKey","key":"Enter","reason":"submit login"}',
      '{"action":"done"}',
    ]);
    const found = await discover("log in", { driver, llm });
    expect(found.steps[0]?.expect).toEqual({
      requestStatus: { urlIncludes: "api.app/auth/sign-in", status: 200, method: "POST" },
    });
  });

  it("assignStepExpects attributes each request tail to its own step (retroactive slicing)", () => {
    // Step 1 fired the POST (tail [0,1)); step 2 navigated (url differs at the final evidence).
    const steps: Step[] = [
      { kind: "click", target: { text: "Submit" } },
      { kind: "click", target: { text: "Go" } },
    ];
    const marks = [
      { url: "https://app/form", requestCount: 0 },
      { url: "https://app/form", requestCount: 1 },
    ];
    const evidence: Evidence = {
      execution: { actions: [], navigated: true, finalUrl: "https://app/done", blocked: false },
      perception: {},
      logic: {
        requests: [{ method: "POST", url: "https://api.app/orders", status: 201 }],
        console: [],
      },
    };
    assignStepExpects(steps, marks, evidence);
    expect(steps[0]?.expect).toEqual({
      requestStatus: { urlIncludes: "api.app/orders", status: 201, method: "POST" },
    });
    expect(steps[1]?.expect).toEqual({ url: "app/done" });
  });

  it("query-only navigation falls through to the mutation expect (#96)", () => {
    // /list?page=1 → /list?page=2 with a successful POST in the step's tail: the frozen expect
    // must be the request (proof the action fired), never a URL the pre-navigation page already
    // satisfies — that expect would make replay's idempotency pre-check skip the step silently.
    const steps: Step[] = [{ kind: "click", target: { text: "Next" } }];
    const marks = [{ url: "https://app/list?page=1", requestCount: 0 }];
    assignStepExpects(steps, marks, evidenceAt("https://app/list?page=2", [
      { method: "POST", url: "https://api.app/list/next", status: 200 },
    ]));
    expect(steps[0]?.expect).toEqual({
      requestStatus: { urlIncludes: "api.app/list/next", status: 200, method: "POST" },
    });
  });

  it("hash-only navigation with no mutation freezes NO expect (#96)", () => {
    // /app → /app#/cart, nothing fired: a URL expect would be pre-satisfied (silent skip) and a
    // weak substitute would trigger false divergence — an unproven step stays unchecked.
    const steps: Step[] = [{ kind: "click", target: { text: "Cart" } }];
    const marks = [{ url: "https://app/app", requestCount: 0 }];
    assignStepExpects(steps, marks, evidenceAt("https://app/app#/cart", []));
    expect(steps[0]?.expect).toBeUndefined();
  });

  describe("URL-corpus: a URL expect is assigned iff the destination (host+path) changed (#96)", () => {
    for (const c of DESTINATION_CHANGE_CORPUS) {
      it(`${c.note} → ${c.changed ? "URL expect" : "no expect"}`, () => {
        const steps: Step[] = [{ kind: "click", target: { text: "Go" } }];
        const marks = [{ url: c.before, requestCount: 0 }];
        assignStepExpects(steps, marks, evidenceAt(c.after, []));
        if (c.changed) expect(steps[0]?.expect).toEqual({ url: destinationKey(c.after) });
        else expect(steps[0]?.expect).toBeUndefined();
      });
    }
  });

  it("can produce a waitFor step (P4 — discover synchronizes, not just replay)", async () => {
    const driver = new StubDriver("https://app/dashboard"); // the awaited condition already holds
    const llm = new ScriptedLlm([
      '{"action":"waitFor","until":{"url":"dashboard"},"reason":"auth redirect lands"}',
      '{"action":"done"}',
    ]);
    const found = await discover("wait then done", { driver, llm });
    expect(found.steps[0]).toMatchObject({ kind: "waitFor", until: { url: "dashboard" } });
  });
});

describe("freshMutationExpect refuses a host-only endpoint (#172 parity)", () => {
  // The assertion path drops such a value because any request to that host satisfies it. The step
  // expect froze it anyway, so a replay could pass its post-condition on an unrelated POST.
  it("freezes nothing when the id is the whole path", () => {
    expect(freshMutationExpect([{ method: "POST", url: "https://api.shop.co/586738", status: 201 }])).toBeUndefined();
  });

  it("freezes nothing for a root mutation", () => {
    expect(freshMutationExpect([{ method: "POST", url: "https://api.shop.co/", status: 201 }])).toBeUndefined();
  });

  it("skips past a host-only mutation to the real one behind it", () => {
    // A pixel or RPC fired at the root must not cost the step its actual proof.
    const tail: NetworkRequest[] = [
      { method: "POST", url: "https://api.shop.co/", status: 204 },
      { method: "POST", url: "https://shop.co/api/orders/586738/confirm", status: 200 },
    ];
    expect(freshMutationExpect(tail)).toEqual({
      requestStatus: { urlIncludes: "shop.co/api/orders", status: 200, method: "POST" },
    });
  });

  it("still freezes when a path survives the cut", () => {
    expect(freshMutationExpect([{ method: "POST", url: "https://api.shop.co/orders/586738", status: 201 }])).toEqual({
      requestStatus: { urlIncludes: "api.shop.co/orders", status: 201, method: "POST" },
    });
  });
});

describe("a step's URL expect generalizes the run's own ids (#172 on the URL path)", () => {
  it("freezes a wildcard for the minted segment, while the move itself is judged on the real urls", () => {
    const steps: Step[] = [{ kind: "click", target: { text: "Place order" } }];
    const marks = [{ url: "https://shop.co/checkout", requestCount: 0 }];
    assignStepExpects(steps, marks, evidenceAt("https://shop.co/orders/586738/done", []));
    expect(steps[0]?.expect).toEqual({ url: "shop.co/orders/*/done" });
  });

  it("a query-only move still freezes no URL expect (#96 unchanged)", () => {
    const steps: Step[] = [{ kind: "click", target: { text: "Next" } }];
    const marks = [{ url: "https://shop.co/list?page=1", requestCount: 0 }];
    assignStepExpects(steps, marks, evidenceAt("https://shop.co/list?page=2", []));
    expect(steps[0]?.expect).toBeUndefined();
  });
});

describe("a generalized URL expect must not pre-satisfy its own step (#96)", () => {
  it("freezes no URL expect for a move between two siblings of one template", () => {
    // /orders/111 → /orders/222 both match shop.co/orders/*, and replay pre-checks a URL expect
    // before running the step — freezing it would make the step skip itself.
    const steps: Step[] = [{ kind: "click", target: { text: "Next order" } }];
    const marks = [{ url: "https://shop.co/orders/111", requestCount: 0 }];
    assignStepExpects(steps, marks, evidenceAt("https://shop.co/orders/222", []));
    expect(steps[0]?.expect).toBeUndefined();
  });

  it("that step still gets its mutation expect when one fired", () => {
    const steps: Step[] = [{ kind: "click", target: { text: "Next order" } }];
    const marks = [{ url: "https://shop.co/orders/111", requestCount: 0 }];
    assignStepExpects(
      steps,
      marks,
      evidenceAt("https://shop.co/orders/222", [
        { method: "POST", url: "https://shop.co/api/orders/222/open", status: 200 },
      ]),
    );
    expect(steps[0]?.expect).toEqual({
      requestStatus: { urlIncludes: "shop.co/api/orders", status: 200, method: "POST" },
    });
  });

  it("list → detail freezes NO url expect: a wildcard leaf names an area, not a page", () => {
    // The cost of the wildcard-leaf rule, taken deliberately: `/orders/*` is satisfied by
    // `/orders/login` in an app that routes it there, and one run cannot tell us whether it does.
    const steps: Step[] = [{ kind: "click", target: { text: "Order 586738" } }];
    const marks = [{ url: "https://shop.co/orders", requestCount: 0 }];
    assignStepExpects(steps, marks, evidenceAt("https://shop.co/orders/586738", []));
    expect(steps[0]?.expect).toBeUndefined();
  });

  it("…and still freezes one when the destination ends in a literal segment", () => {
    const steps: Step[] = [{ kind: "click", target: { text: "Place order" } }];
    const marks = [{ url: "https://shop.co/checkout", requestCount: 0 }];
    assignStepExpects(steps, marks, evidenceAt("https://shop.co/orders/586738/done", []));
    expect(steps[0]?.expect).toEqual({ url: "shop.co/orders/*/done" });
  });

  it("freezes no URL expect when nothing but the host would survive", () => {
    const steps: Step[] = [{ kind: "click", target: { text: "Open" } }];
    const marks = [{ url: "https://shop.co/home", requestCount: 0 }];
    assignStepExpects(steps, marks, evidenceAt("https://shop.co/586738", []));
    expect(steps[0]?.expect).toBeUndefined();
  });
});

describe("the freeze decides a URL expect under the consumer's matching rules", () => {
  it("does not freeze an expect the replay-side locale list would pre-satisfy", () => {
    // A step that redirects /cart → /de/cart: with "de" injected, replay's pre-check finds the
    // pre-navigation page already reaches shop.co/de/cart and skips the step. Freezing under the
    // engine defaults while replay runs with the consumer list is exactly that mismatch (#86).
    const steps: Step[] = [{ kind: "click", target: { text: "Cart" } }];
    const marks = [{ url: "https://shop.co/cart", requestCount: 0 }];
    assignStepExpects(steps, marks, evidenceAt("https://shop.co/de/cart", []), { localePrefixes: ["de"] });
    expect(steps[0]?.expect).toBeUndefined();
  });

  it("…and still freezes it when the consumer declares no such locale", () => {
    const steps: Step[] = [{ kind: "click", target: { text: "Cart" } }];
    const marks = [{ url: "https://shop.co/cart", requestCount: 0 }];
    assignStepExpects(steps, marks, evidenceAt("https://shop.co/de/cart", []));
    expect(steps[0]?.expect).toEqual({ url: "shop.co/de/cart" });
  });
});

describe("freshMutationExpect takes the product's benign list", () => {
  it("benignListReachesFreshMutationExpect: a product-marked mutation is skipped, the real one behind it is kept", () => {
    const tail = [
      { method: "POST", url: "https://analytics.x/track/events", status: 200 },
      { method: "POST", url: "https://api.shop.co/orders", status: 201 },
    ];
    expect(freshMutationExpect(tail, ["analytics.x"])).toEqual({
      requestStatus: { urlIncludes: "api.shop.co/orders", status: 201, method: "POST" },
    });
    expect(freshMutationExpect([tail[0]!], ["analytics.x"])).toBeUndefined();
  });
});

describe("observeOutcomes waits for an in-flight mutation only up to its deadline", () => {
  /** A mutation that never lands: status 0 on every observation. */
  class StuckStub extends StubDriver {
    observes = 0;

    override async observe(): Promise<Evidence> {
      this.observes += 1;
      return {
        execution: { actions: [], navigated: false, finalUrl: this.url, blocked: false },
        perception: {},
        logic: {
          requests: [{ method: "POST", url: "https://api.app/orders", status: 0 }],
          console: [],
        },
      };
    }
  }

  afterEach(() => vi.useRealTimers());

  it("observeOutcomesDeadline: returns the still-unsettled evidence once the window expires, after polling", async () => {
    vi.useFakeTimers();
    const driver = new StuckStub();
    const done = observeOutcomes(driver, 0);
    await vi.advanceTimersByTimeAsync(2_500);
    const outcome = await done;
    expect(outcome.logic.requests[0]?.status).toBe(0);
    expect(driver.observes).toBeGreaterThan(1);
  });

  it("observeOutcomesDeadline: a request before the watermark is not waited on", async () => {
    vi.useFakeTimers();
    const driver = new StuckStub();
    const done = observeOutcomes(driver, 1);
    await vi.advanceTimersByTimeAsync(0);
    await done;
    expect(driver.observes).toBe(1);
  });
});
