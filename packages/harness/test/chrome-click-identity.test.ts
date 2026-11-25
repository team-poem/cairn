import { expect, test } from "vitest";
import { ChromeDevToolsDriver } from "../src/adapters/drivers/chrome.js";

const key = "bad40d2a-8a61-4e06-a563-9a0672b8a949:1";
const target = {role: "heading", text: "Account"};
const dialog = "# Open dialog\nconfirm: Proceed?.\nCall handle_dialog to handle it before continuing.";
function fixture(options: { id?: unknown; reached?: boolean; failure?: string; failureTool?: string; ref?: boolean; afterClick?: () => string;
  probeError?: { stage: "prepare" | "read"; error: Error } } = {}) {
  const calls: string[] = [];
  const driver = new ChromeDevToolsDriver();
  Object.assign(driver, {
    actionUid: async () => { calls.push("resolve"); return "latest_uid"; },
    followNewTab: async () => { calls.push("follow"); return false; },
    client: {callTool: async ({name, arguments: args}: {name: string; arguments: Record<string, unknown>}) => {
      let text = "OK";
      if (name === "evaluate_script") {
        if (options.probeError?.stage === (args.args ? "prepare" : "read")) throw options.probeError.error;
        if (args.args) {
          calls.push("prepare");
          expect(args.args).toEqual(["latest_uid"]);
          text = JSON.stringify({id: options.id ?? key});
        } else {
          calls.push("read");
          text = JSON.stringify({reached: options.reached ?? true});
        }
      } else {
        calls.push(name);
        if (name === "click") {
          expect(args).toEqual({uid: "latest_uid"});
          if (options.afterClick) text = options.afterClick();
        }
        if (options.failure && name === (options.failureTool ?? "click"))
          return { isError:true, content:[{type:"text", text:options.failure}] };
      }
      return {content:[{type:"text", text}]};
    }},
  });
  if (options.ref) Object.assign(driver, {references: new Map([["ephemeral", {uid: "latest_uid"}]])});
  return {driver, calls, run:() => driver.click(target, options.ref ? "ephemeral" : undefined)};
}

test.each([false, true])("only one armed click pays for the two identity probes (exact ref=%s)", async ref => {
  const {driver, calls, run} = fixture({ref});
  driver.armActionOutcomeIdentity(id => { expect(id).toBe(key); calls.push("admit"); });
  await run();
  expect(calls).toEqual([...(ref ? ["prepare", "resolve"] : ["resolve", "prepare"]), "admit", "click", "read", "follow"]);
  expect(driver.takeActionOutcomeIdentity()).toBe(key);
  expect(driver.takeActionOutcomeIdentity()).toBeUndefined();
  calls.length = 0;
  await run();
  expect(calls).toEqual(["resolve", "click", "follow"]);
});

test("callback rejection happens before the input and cannot be interpreted as an app dialog", async () => {
  const {driver, calls, run} = fixture();
  const reason = new Error(dialog);
  driver.armActionOutcomeIdentity(() => { throw reason; });
  await expect(run()).rejects.toBe(reason);
  expect(calls).toEqual(["resolve", "prepare"]);
  expect(driver.takeActionOutcomeIdentity()).toBeUndefined();
});

test("only a well-formed key reaches the callback, and no receipt can be invented from the name", async () => {
  const {driver, calls, run} = fixture({id: "Account"});
  driver.armActionOutcomeIdentity(id => { expect(id).toBeUndefined(); calls.push("admit"); });
  await run();
  expect(calls).toEqual(["resolve","prepare","admit","click","follow"]);
  expect(driver.takeActionOutcomeIdentity()).toBeUndefined();
});

test.each(["no ACK", dialog])("a rejected click reply supplies no identity even if the dialog path handles it: %s", async failure => {
  const {driver, calls, run} = fixture({failure});
  driver.armActionOutcomeIdentity();
  await expect(run()).rejects.toThrow();
  expect(calls.filter(call => call === "click")).toHaveLength(1);
  expect(calls).not.toContain("read");
  expect(calls).not.toContain("handle_dialog");
  expect(driver.takeActionOutcomeIdentity()).toBeUndefined();
});

test("a successful click whose event cannot be confirmed is not retried", async () => {
  const {driver, calls, run} = fixture({reached:false});
  driver.armActionOutcomeIdentity();
  await run();
  expect(driver.takeActionOutcomeIdentity()).toBeUndefined();
  expect(calls.filter(call => call === "click")).toHaveLength(1);
});

const alert = "# Open dialog\nalert: Done.\nCall handle_dialog to handle it before continuing.";
const timeout = "\nError: Failed to interact with the element with uid latest_uid. The element did not become interactive within the configured timeout.";
test.each(["prepare", "read"] as const)("don't swallow a dead transport during %s, including after handling an alert", async stage => {
  const error = Object.assign(new Error("transport lost"), {kind:"transport"});
  const { driver, calls, run } = fixture({ probeError:{ stage, error }, failure:alert + timeout });
  driver.armActionOutcomeIdentity();
  await expect(run()).rejects.toBe(error);
  expect(calls.filter(n => n === "click" || n === "handle_dialog")).toEqual(stage === "prepare" ? [] : ["click", "handle_dialog"]);
  expect(driver.takeActionOutcomeIdentity()).toBeUndefined();
});
test.each([true, false])("recover a timeout on an informational alert only if the original trusted event was seen (%s)", async reached => {
  const { driver, calls, run } = fixture({ reached, failure: alert + timeout });
  driver.armActionOutcomeIdentity();
  if (reached) await run();
  else await expect(run()).rejects.toThrow(/Failed to interact/);
  expect(calls.filter(n => ["click", "handle_dialog", "read"].includes(n))).toEqual(["click", "handle_dialog", "read"]);
  expect(driver.takeActionOutcomeIdentity()).toBe(reached ? key : undefined);
});

test.each([dialog + timeout, alert + "\nError: A dialog is open (alert: Done).",
  alert + timeout + "\nCause: Protocol error (Input.dispatchMouseEvent): Target closed"])(
  "do not approve an uncertain choice, pre-existing dialog, or transport error", async failure => {
    const { driver, calls, run } = fixture({ failure });
    driver.armActionOutcomeIdentity();
    await expect(run()).rejects.toThrow();
    expect(calls.filter(n => ["click", "handle_dialog", "read"].includes(n))).toEqual(["click"]);
  });

test("dispatch callback sees actual inputs, not resolution or identity probes, and a veto cannot dismiss a dialog", async () => {
  const { driver, calls, run } = fixture();
  driver.armActionOutcomeDispatch(() => { calls.push("send"); });
  driver.armActionOutcomeIdentity(() => { calls.push("admit"); });
  await run();
  expect(calls).toEqual(["resolve","prepare","admit","send","click","read","follow"]);
  driver.takeActionOutcomeIdentity();
  const reason = new Error(alert);
  driver.armActionOutcomeDispatch(() => { throw reason; });
  calls.length = 0;
  await expect(driver.type(target, "value")).rejects.toBe(reason);
  expect(calls).toEqual(["resolve"]);
  driver.clearActionOutcomeDispatch();
});

test("select counts the opener send even if resolving its option fails; a missing control sends nothing", async () => {
  const { driver, calls } = fixture();
  Object.assign(driver, { isNativeSelect: () => false, snapshotCache: "uid=a combobox \"Menu\"", awaitNewOption: () => undefined });
  driver.armActionOutcomeDispatch(() => { calls.push("send"); });
  await expect(driver.select(target, "Absent")).rejects.toThrow(/no matching option/);
  expect(calls).toEqual(["resolve","send","click","follow"]);
  calls.length = 0;
  Object.assign(driver, { actionUid: () => { throw new Error("missing textbox"); } });
  await expect(driver.type(target, "x")).rejects.toThrow("missing textbox");
  expect(calls).toEqual([]);
});

test("a rejected fill with an open confirm is not acknowledged or accepted for the user", async () => {
  const { driver, calls } = fixture({ failure:dialog + timeout, failureTool:"fill" });
  driver.armActionOutcomeDispatch(() => { calls.push("send"); });
  await expect(driver.type(target, "text")).rejects.toThrow(/Failed to interact/);
  expect(calls).toEqual(["resolve","send","fill"]);
});

test("a stop after acknowledged input vetoes dialog acceptance without re-admitting or retrying the click", async () => {
  const signal = new AbortController();
  const reason = new Error("stopped after click");
  const { driver, calls, run } = fixture({ afterClick() {
    signal.abort(reason);
    return "Successfully clicked on the element\n" + dialog;
  } });
  driver.armActionOutcomeIdentity(() => { calls.push("admit"); }, () => signal.signal.throwIfAborted());
  await expect(run()).rejects.toBe(reason);
  expect(calls).toEqual(["resolve", "prepare", "admit", "click"]);
  expect(driver.takeActionOutcomeIdentity()).toBeUndefined();
});
