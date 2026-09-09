import { test, expect } from "vitest";

test("rankMatchingEvidenceZeroBudget: matching evidence does not bypass an empty ranking budget", async () => {
  const { rankElements } = await import("../src/core/discover/prompt.js");
  expect(rankElements([{ role: "StaticText", name: "account saved" }], "account", 0)).toEqual([]);
});
