import { describe, expect, it } from "vitest";
import { flagNum, flagStr, parseArgs } from "../src/cli-args.js";

describe("parseArgs", () => {
  it("supports --key=value flags", () => {
    const { positionals, flags } = parseArgs([
      "find checkout",
      "--url=https://example.test/app",
      "--model=haiku",
    ]);

    expect(positionals).toEqual(["find checkout"]);
    expect(flagStr(flags, "url")).toBe("https://example.test/app");
    expect(flagStr(flags, "model")).toBe("haiku");
  });

  it("splits --key=value on the first equals sign", () => {
    const { flags } = parseArgs(["--url=https://example.test/?q=a=b"]);

    expect(flagStr(flags, "url")).toBe("https://example.test/?q=a=b");
  });

  it("keeps values that start with -- when using --key=value", () => {
    const { flags } = parseArgs(["--model=--haiku"]);

    expect(flagStr(flags, "model")).toBe("--haiku");
  });

  it("keeps existing space-separated flags and boolean flags", () => {
    const { flags } = parseArgs(["--url", "https://example.test", "--semantic"]);

    expect(flagStr(flags, "url")).toBe("https://example.test");
    expect(flags.get("semantic")).toBe(true);
  });
});

describe("flagNum — numeric flags (--max-steps, --expect-timeout)", () => {
  it("parses a positive integer, in both flag forms", () => {
    expect(flagNum(parseArgs(["--max-steps=12"]).flags, "max-steps")).toBe(12);
    expect(flagNum(parseArgs(["--expect-timeout", "5000"]).flags, "expect-timeout")).toBe(5000);
  });

  it("returns undefined when the flag is absent (library default applies)", () => {
    expect(flagNum(parseArgs([]).flags, "max-steps")).toBeUndefined();
  });

  it("rejects a non-numeric value with a clear error", () => {
    expect(() => flagNum(parseArgs(["--max-steps=lots"]).flags, "max-steps")).toThrow(/--max-steps/);
  });

  it("rejects a valueless (boolean) use", () => {
    expect(() => flagNum(parseArgs(["--expect-timeout"]).flags, "expect-timeout")).toThrow(/--expect-timeout/);
  });

  it("rejects zero and negative values", () => {
    expect(() => flagNum(parseArgs(["--max-steps=0"]).flags, "max-steps")).toThrow(/--max-steps/);
    expect(() => flagNum(parseArgs(["--expect-timeout=-1"]).flags, "expect-timeout")).toThrow(/--expect-timeout/);
  });
});
