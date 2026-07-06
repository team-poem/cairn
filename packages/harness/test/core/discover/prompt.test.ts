import { describe, expect, it } from "vitest";
import { rankElements } from "../../../src/core/discover/prompt.js";

describe("rankElements (#15)", () => {
  it("keeps an interactive, intent-relevant control inside the cutoff past a wall of noise", () => {
    const noise = Array.from({ length: 70 }, (_, i) => ({ role: "paragraph", name: `text ${i}` }));
    const ranked = rankElements([...noise, { role: "button", name: "Checkout now" }], "checkout", 60);
    // a flat slice(0, 60) would drop the button at index 70; ranking pulls it in.
    expect(ranked).toContainEqual({ role: "button", name: "Checkout now" });
    expect(ranked).toHaveLength(60);
  });

  it("boosts an intent-relevant control for a non-ASCII (Korean) intent (P8)", () => {
    const els = [
      { role: "button", name: "취소" }, // interactive, not intent-relevant
      { role: "button", name: "결제하기" }, // interactive + matches the "결제" token
    ];
    // before P8, `\W` split yielded no Korean tokens, so relevance never broke the tie
    expect(rankElements(els, "결제 진행", 60)[0]).toEqual({ role: "button", name: "결제하기" });
  });
});

describe("renderElements — form state (#93)", () => {
  it("shows checked/disabled/value so the LLM stops re-clicking done work", async () => {
    const { renderElements } = await import("../../../src/core/discover/prompt.js");
    const out = renderElements([
      { role: "checkbox", name: "Terms", checked: true },
      { role: "checkbox", name: "Partial", checked: "mixed" },
      { role: "button", name: "Pay", disabled: true },
      { role: "textbox", name: "Email", value: "a@b.com" },
      { role: "link", name: "Home" },
    ]);
    expect(out).toContain('- [checkbox] Terms (checked)');
    expect(out).toContain('- [checkbox] Partial (mixed)');
    expect(out).toContain('- [button] Pay (disabled)');
    expect(out).toContain('- [textbox] Email = "a@b.com"');
    expect(out).toContain('- [link] Home');
  });
});

describe("renderRankedElements — truncation is never silent", () => {
  it("appends a notice when the cap hides elements", async () => {
    const { renderRankedElements } = await import("../../../src/core/discover/prompt.js");
    const many = Array.from({ length: 70 }, (_, i) => ({ role: "button", name: `b${i}` }));
    const out = renderRankedElements(many, "x", 60);
    expect(out).toContain("(+10 more elements not shown");
  });
  it("adds nothing when everything fits", async () => {
    const { renderRankedElements } = await import("../../../src/core/discover/prompt.js");
    expect(renderRankedElements([{ role: "button", name: "Go" }], "x", 60)).toBe("- [button] Go");
  });
});

describe("interactive roles", () => {
  it("a listbox outranks a wall of static noise (custom dropdowns stay visible)", async () => {
    const { rankElements } = await import("../../../src/core/discover/prompt.js");
    const noise = Array.from({ length: 70 }, (_, i) => ({ role: "StaticText", name: `t${i}` }));
    const ranked = rankElements([...noise, { role: "listbox", name: "Options" }], "pick", 60);
    expect(ranked.some((e) => e.role === "listbox")).toBe(true);
  });
});

describe("evidence quota (#115) — counterexample table for the ranking zone", () => {
  const buttons = (n: number) => Array.from({ length: n }, (_, i) => ({ role: "button", name: `btn${i}` }));
  const text = (name: string) => ({ role: "StaticText", name });
  const has = (r: { name: string }[], name: string) => r.some((e) => e.name === name);

  const table: Array<{
    name: string;
    elements: { role: string; name: string }[];
    intent: string;
    limit: number;
    expect: (r: { role: string; name: string }[]) => void;
  }> = [
    {
      name: "success text past the cap survives on a heavy page",
      elements: [...buttons(70), text("Your order is complete")],
      intent: "complete the order",
      limit: 60,
      expect: (r) => {
        if (!has(r, "Your order is complete")) throw new Error("evidence dropped");
        if (r.length !== 60) throw new Error("cap changed");
      },
    },
    {
      name: "non-matching text stays out — no free pass for noise",
      elements: [...buttons(70), text("all rights reserved")],
      intent: "complete the order",
      limit: 60,
      expect: (r) => {
        if (has(r, "all rights reserved")) throw new Error("noise admitted");
      },
    },
    {
      name: "under the cap: behavior identical to before",
      elements: [...buttons(10), text("done!")],
      intent: "done",
      limit: 60,
      expect: (r) => {
        if (r.length !== 11) throw new Error("changed a page that fits");
      },
    },
    {
      name: "evidence already inside the cut: no duplicate, no eviction",
      elements: [text("order complete"), ...buttons(10)],
      intent: "order",
      limit: 60,
      expect: (r) => {
        if (r.filter((e) => e.name === "order complete").length !== 1) throw new Error("duplicated");
        if (r.length !== 11) throw new Error("evicted needlessly");
      },
    },
    {
      name: "quota is bounded: at most 5 evidence rows admitted",
      elements: [...buttons(70), ...Array.from({ length: 10 }, (_, i) => text(`order note ${i}`))],
      intent: "order",
      limit: 60,
      expect: (r) => {
        const admitted = r.filter((e) => e.role === "StaticText").length;
        if (admitted !== 5) throw new Error(`expected 5 evidence rows, got ${admitted}`);
        if (r.length !== 60) throw new Error("cap changed");
      },
    },
    {
      name: "interactive priority preserved: intent-matching button still ranks in",
      elements: [...buttons(70), { role: "button", name: "order now" }, text("order complete")],
      intent: "order",
      limit: 60,
      expect: (r) => {
        if (!has(r, "order now")) throw new Error("intent-matching control dropped");
        if (!has(r, "order complete")) throw new Error("evidence dropped");
      },
    },
  ];

  for (const t of table) {
    it(t.name, () => {
      t.expect(rankElements(t.elements, t.intent, t.limit));
    });
  }
});
