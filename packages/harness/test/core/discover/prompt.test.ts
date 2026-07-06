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
