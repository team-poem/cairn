import { describe, expect, it } from "vitest";
import { flagStr, parseArgs } from "../src/cli-args.js";

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
