import { describe, expect, it } from "vitest";
import { extractFirstJsonArray, extractFirstJsonObject } from "./json.js";

describe("extractFirstJsonObject", () => {
  it("parses a bare object", () => {
    expect(extractFirstJsonObject('{"name":"Log in"}')).toEqual({
      name: "Log in",
    });
  });

  it("strips markdown fences", () => {
    expect(extractFirstJsonObject('```json\n{"name":"Log in"}\n```')).toEqual({
      name: "Log in",
    });
  });

  it("returns the FIRST object when the reply has two (the crash case)", () => {
    expect(
      extractFirstJsonObject('{"name":"Log in"}\n\n{"note":"extra"}'),
    ).toEqual({
      name: "Log in",
    });
  });

  it("ignores trailing prose after the object", () => {
    expect(
      extractFirstJsonObject('{"name":"Log in"}\nThat is my choice.'),
    ).toEqual({
      name: "Log in",
    });
  });

  it("is not fooled by braces inside strings", () => {
    expect(extractFirstJsonObject('{"name":"a } b"}')).toEqual({
      name: "a } b",
    });
  });

  it("returns undefined when there is no object", () => {
    expect(extractFirstJsonObject("no json here")).toBeUndefined();
  });

  it("resumes past a non-JSON brace region preceding the real object", () => {
    expect(
      extractFirstJsonObject('Use the {action} field: {"action":"click"}'),
    ).toEqual({ action: "click" });
  });

  it("returns undefined when every brace region fails to parse", () => {
    expect(extractFirstJsonObject("{action} {target}")).toBeUndefined();
  });

  it("does not dig into a nested object when the outer region is invalid JSON", () => {
    // The outer object is malformed (unquoted key); the inner is well-formed but must NOT be
    // mistaken for the reply — returning it would fail OPEN (e.g. a critic false-PASS).
    expect(
      extractFirstJsonObject('{verdict: {"passed": true, "detail": "ok"}}'),
    ).toBeUndefined();
  });
});

describe("extractFirstJsonArray", () => {
  it("parses a bare array", () => {
    expect(extractFirstJsonArray('[{"kind":"navigated"}]')).toEqual([
      { kind: "navigated" },
    ]);
  });

  it("resumes past a non-JSON bracket region preceding the real array", () => {
    expect(
      extractFirstJsonArray('items like [x] then [{"kind":"navigated"}]'),
    ).toEqual([{ kind: "navigated" }]);
  });

  it("returns undefined when there is no array", () => {
    expect(extractFirstJsonArray("no json here")).toBeUndefined();
  });

  it("does not extract a bracket that lives inside a string literal", () => {
    // The whole array is malformed (unquoted `bad`); the `[1,2,3]` is inside a string and must
    // not be scanned as a sibling — resume must skip the entire failed region, not one char.
    expect(extractFirstJsonArray('[bad, "see [1,2,3]"]')).toBeUndefined();
  });
});
