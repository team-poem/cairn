import { describe, expect, it } from "vitest";
import { fillSecrets, hasSecretPlaceholder, redactSecrets, slotSecrets } from "../../src/core/secrets.js";
import { errorKindOf } from "../../src/core/errors.js";
import { runScenario } from "../../src/run.js";
import { discover } from "../../src/core/discover/index.js";
import { FakeDriver } from "../../src/adapters/drivers/fake.js";
import { ScriptedLlm, StubDriver } from "../support/doubles.js";
import { parseArgs } from "../../src/cli-args.js";
import { secretsFromFlags } from "../../src/cli-secrets.js";
import type { Evidence, Scenario, Step, Target } from "../../src/core/types.js";

describe("fillSecrets (#174)", () => {
  it("fills every {name}, leaves everything else alone", () => {
    expect(fillSecrets("{user}:{password}", { user: "alice", password: "hunter2" })).toBe("alice:hunter2");
    expect(fillSecrets('{"a":1} and {not a placeholder', { a: "x" })).toBe('{"a":1} and {not a placeholder');
    expect(hasSecretPlaceholder("plain text")).toBe(false);
    expect(hasSecretPlaceholder("x {token} y")).toBe(true);
  });

  it("{{name}} is the escape: it types the literal {name}", () => {
    expect(fillSecrets("{{count}} items, {user}", { user: "alice" })).toBe("{count} items, alice");
    expect(hasSecretPlaceholder("{{count}} items")).toBe(false);
    expect(fillSecrets("{{count}}", {})).toBe("{count}");
  });

  it("the port counts when the origin names one — localhost:3000 is not localhost:4000", () => {
    const secrets = { password: { value: "hunter2", origin: "http://localhost:3000" } };
    expect(fillSecrets("{password}", secrets, "http://localhost:3000/login")).toBe("hunter2");
    expect(() => fillSecrets("{password}", secrets, "http://localhost:4000/login")).toThrow(/refused on http:\/\/localhost:4000\/login/);
  });

  it("a refusal names the page as origin+path, never its query", () => {
    const secrets = { password: { value: "hunter2", origin: "https://app.example" } };
    expect(() => fillSecrets("{password}", secrets, "https://pay.provider.com/cb?session=SECRET_TOKEN&x=1")).toThrow(/refused on https:\/\/pay.provider.com\/cb$/);
  });

  it("redactSecrets masks a typed value wherever the snapshot shows it back", () => {
    const secrets = { user: "alice", password: "hunter2" };
    const els = [{ role: "textbox", name: "Username", value: "alice" }, { role: "textbox", name: "Password", value: "•••••" }, { role: "textbox", name: "hunter2" }, { role: "button", name: "Sign in" }];
    expect(redactSecrets(els, secrets)).toEqual([
      { role: "textbox", name: "Username", value: "{user}" }, { role: "textbox", name: "Password", value: "•••••" }, { role: "textbox", name: "{password}" }, { role: "button", name: "Sign in" },
    ]);
    expect(redactSecrets(els, {})).toEqual(els);
  });

  it("slotSecrets puts the placeholder back into a type step that carries the value", () => {
    const steps: Step[] = [{ kind: "type", target: { text: "Password" }, text: "hunter2" }, { kind: "type", target: { text: "Note" }, text: "plain" }, { kind: "click", target: { text: "Go" } }];
    slotSecrets(steps, { password: { value: "hunter2", origin: "https://app.example" } });
    expect(steps[0]).toMatchObject({ text: "{password}" });
    expect(steps[1]).toMatchObject({ text: "plain" });
  });

  it("a placeholder with no value is the host's wiring — handler, exit 4", () => {
    let caught: unknown;
    try { fillSecrets("{password}", {}); } catch (e) { caught = e; }
    expect(errorKindOf(caught)).toBe("handler");
    expect((caught as Error).message).toContain("--secret password=");
  });

  it("a scoped secret is refused off its origin, and when the page is unknown", () => {
    const secrets = { password: { value: "hunter2", origin: "https://app.example" } };
    expect(fillSecrets("{password}", secrets, "https://app.example/login")).toBe("hunter2");
    expect(fillSecrets("{password}", secrets, "https://auth.app.example/login")).toBe("hunter2"); // same site
    expect(() => fillSecrets("{password}", secrets, "https://pay.provider.com/login")).toThrow(/belongs to https:\/\/app.example and is refused on https:\/\/pay.provider.com/);
    expect(() => fillSecrets("{password}", secrets)).toThrow(/refused on an unknown page/);
    let caught: unknown;
    try { fillSecrets("{password}", secrets, "https://pay.provider.com/"); } catch (e) { caught = e; }
    expect(errorKindOf(caught)).toBeUndefined(); // the script's: it would type a secret where it does not belong
  });
});

describe("replay fills for the driver and keeps the placeholder everywhere else", () => {
  class Typing extends FakeDriver { typed: string[] = []; override async type(t: Target, text: string) { this.typed.push(text); await super.type(t, text); } }
  const evidence: Evidence = { execution: { actions: [], navigated: true, finalUrl: "https://app.example/home", blocked: false }, perception: {}, logic: { requests: [], console: [] } };
  const scenario: Scenario = {
    name: "login",
    steps: [{ kind: "goto", url: "https://app.example/login" }, { kind: "type", target: { text: "Password" }, text: "{password}" }],
    assertions: [{ kind: "navigated", to: "app.example/home" }],
  };
  const silent = { emit: async () => {} };

  it("the driver gets the value; the action, the result and the skill keep {password}", async () => {
    const driver = new Typing({ evidence });
    const { result } = await runScenario(scenario, { driver, reporter: silent, secrets: { password: "hunter2" } });
    expect(driver.typed).toEqual(["hunter2"]);
    expect(result.verdict.passed).toBe(true);
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(result.evidence.execution.actions[1]?.step).toMatchObject({ kind: "type", text: "{password}" });
  });

  it("no value → the step fails closed as the host's wiring", async () => {
    const { result } = await runScenario(scenario, { driver: new Typing({ evidence }), reporter: silent });
    expect(result.verdict).toMatchObject({ passed: false, failClosed: "blocked", failure: "environment" });
    expect(result.evidence.execution.actions[1]).toMatchObject({ ok: false, errorKind: "handler" });
  });

  it("a missing secret does not trigger outcome-heal — a re-discovery cannot supply it", async () => {
    const llm = { id: "never", complete: async () => { throw new Error("must not be called"); } };
    const { result, heals } = await runScenario(scenario, { driver: new Typing({ evidence }), reporter: silent, heal: true, llm });
    expect(result.verdict).toMatchObject({ passed: false, failure: "environment" });
    expect(result.usage?.llmCalls ?? 0).toBe(0);
    expect(heals).toEqual([]);
  });

  it("a scoped secret is refused on a page outside its origin", async () => {
    const elsewhere = { ...evidence, execution: { ...evidence.execution, finalUrl: "https://pay.provider.com/login" } };
    const driver = new Typing({ evidence: elsewhere });
    const { result } = await runScenario(scenario, { driver, reporter: silent, secrets: { password: { value: "hunter2", origin: "https://app.example" } } });
    expect(driver.typed).toEqual([]);
    expect(result.verdict).toMatchObject({ passed: false, failure: "script" });
    expect(result.evidence.execution.actions[1]?.error).toMatch(/refused on https:\/\/pay.provider.com/);
  });
});

describe("discovery types the value and freezes the placeholder", () => {
  class Login extends StubDriver {
    typed: string[] = [];
    constructor(url: string) {
      super(url);
      this.els = [{ role: "textbox", name: "Password" }, { role: "button", name: "Sign in" }];
      this.navOn["Sign in"] = "https://app.example/home";
      // StubDriver.type() takes no parameters; the Driver port does — record what the port receives.
      (this as unknown as { type: (t: Target, text: string) => Promise<void> }).type = async (_t, text) => { this.typed.push(text); };
    }
  }
  const llm = () => new ScriptedLlm(['{"action":"type","text":"Password","value":"{password}"}', '{"action":"click","text":"Sign in"}', '{"action":"done"}', "[]"]);

  it("the skill carries {password}; the driver saw the value", async () => {
    const driver = new Login("https://app.example/login");
    const scenario = await discover("log in with {password}", { driver, llm: llm(), baseUrl: "https://app.example/login", secrets: { password: "hunter2" } });
    expect(driver.typed).toEqual(["hunter2"]);
    expect(scenario.steps[1]).toMatchObject({ kind: "type", text: "{password}" });
    expect(JSON.stringify(scenario)).not.toContain("hunter2");
  });

  it("the model never sees the typed value: the next snapshot is redacted before it is rendered", async () => {
    const prompts: string[] = [];
    class Echoing extends Login {
      override async snapshot() { return this.typed.length ? [{ role: "textbox", name: "Password", value: "hunter2" }, { role: "button", name: "Sign in" }] : this.els; }
    }
    const driver = new Echoing("https://app.example/login");
    const scripted = llm();
    const inner = scripted as unknown as { complete: (p: string, o?: unknown) => Promise<string> }; // ScriptedLlm ignores its arguments
    const spy = { id: "spy", complete: async (p: string, o?: unknown) => { prompts.push(p); return inner.complete(p, o); } };
    await discover("log in with {password}", { driver, llm: spy, baseUrl: "https://app.example/login", secrets: { password: "hunter2" } });
    expect(driver.typed).toEqual(["hunter2"]);
    expect(prompts.some((p) => p.includes("hunter2"))).toBe(false);
    expect(prompts.some((p) => p.includes("{password}"))).toBe(true);
  });

  it("a model that echoes the literal instead of the placeholder still freezes the placeholder", async () => {
    const driver = new Login("https://app.example/login");
    const literal = new ScriptedLlm(['{"action":"type","text":"Password","value":"hunter2"}', '{"action":"click","text":"Sign in"}', '{"action":"done"}', "[]"]);
    const scenario = await discover("log in", { driver, llm: literal, baseUrl: "https://app.example/login", secrets: { password: "hunter2" } });
    expect(driver.typed).toEqual(["hunter2"]);
    expect(scenario.steps[1]).toMatchObject({ kind: "type", text: "{password}" });
    expect(JSON.stringify(scenario)).not.toContain("hunter2");
  });

  it("a placeholder nobody supplied aborts discovery instead of burning the step budget", async () => {
    const driver = new Login("https://app.example/login");
    await expect(discover("log in with {password}", { driver, llm: llm(), baseUrl: "https://app.example/login" })).rejects.toThrow(/secret \{password\} is not provided/);
    expect(driver.typed).toEqual([]);
  });

  it("a scoped secret is refused when discovery has wandered off-site — a failed action the model must route around, on the trace", async () => {
    const { Tracer } = await import("../../src/core/trace.js");
    const events: { kind: string; payload: unknown }[] = [];
    const trace = new Tracer({ emit: (e) => { events.push(e); } }).scope("discover");
    const driver = new Login("https://pay.provider.com/login");
    const scenario = await discover("log in with {password}", { driver, llm: llm(), baseUrl: "https://pay.provider.com/login", trace, secrets: { password: { value: "hunter2", origin: "https://app.example" } } });
    expect(driver.typed).toEqual([]);
    expect(scenario.steps.some((s) => s.kind === "type")).toBe(false);
    expect(JSON.stringify(scenario)).not.toContain("hunter2");
    const refused = events.find((e) => e.kind === "action" && (e.payload as { ok: boolean }).ok === false);
    expect((refused?.payload as { error: string }).error).toMatch(/belongs to https:\/\/app.example and is refused on https:\/\/pay.provider.com/);
  });
});

describe("--secret on the CLI", () => {
  it("is repeatable, pairs with --secret-origin, and falls back to CAIRN_SECRET_<NAME>", () => {
    const { flags } = parseArgs(["replay", "x.json", "--secret", "user=alice", "--secret=password=hunter2", "--secret-origin", "password=https://app.example"]);
    expect(secretsFromFlags(flags, { CAIRN_SECRET_TOKEN: "t0k", CAIRN_SECRET_USER: "ignored: the flag wins", PATH: "/bin" })).toEqual({
      user: "alice",
      password: { value: "hunter2", origin: "https://app.example" },
      token: "t0k",
    });
    expect(secretsFromFlags(parseArgs(["replay", "x.json"]).flags, {})).toBeUndefined();
  });

  it("a bare --secret does not wipe the values before it, and is reported as usage", () => {
    const { flags } = parseArgs(["replay", "x.json", "--secret=user=alice", "--secret"]);
    expect(flags.get("secret")).toEqual(["user=alice"]);
    expect(() => secretsFromFlags(parseArgs(["replay", "--secret"]).flags, {})).toThrow(/expects name=value/);
  });

  it("rejects an origin without a scheme up front", () => {
    expect(() => secretsFromFlags(parseArgs(["replay", "--secret", "p=1", "--secret-origin", "p=app.example"]).flags, {})).toThrow(/expects a URL with a scheme/);
  });

  it("rejects a malformed pair and an origin without a value", () => {
    expect(() => secretsFromFlags(parseArgs(["replay", "--secret", "nopair"]).flags, {})).toThrow(/name=value/);
    expect(() => secretsFromFlags(parseArgs(["replay", "--secret-origin", "password=https://x"]).flags, {})).toThrow(/no value for \{password\}/);
  });
});
