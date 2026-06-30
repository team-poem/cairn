import { describe, expect, it } from "vitest";
import { extractFirstJsonObject } from "./json.js";

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
});
