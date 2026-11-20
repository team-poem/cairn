import { expect, test } from "vitest";
import { ChromeDevToolsDriver } from "../src/adapters/drivers/chrome.js";

const key = "bad40d2a-8a61-4e06-a563-9a0672b8a949:1";
const target = {role: "heading", text: "Account"};
const dialog = "# Open dialog\nconfirm: Proceed?.\nCall handle_dialog to handle it before continuing.";
function fixture(options: { id?: unknown; reached?: boolean; failure?: string; ref?: boolean; afterClick?: () => string } = {}) {
  const calls: string[] = [];
  const driver = new ChromeDevToolsDriver();
  Object.assign(driver, {
    actionUid: async () => { calls.push("resolve"); return "latest_uid"; },
    followNewTab: async () => { calls.push("follow"); return false; },
    client: {callTool: async ({name, arguments: args}: {name: string; arguments: Record<string, unknown>}) => {
      let text = "OK";
      if (name === "evaluate_script") {
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
          if (options.failure) return { isError: true, content: [{type:"text", text:options.failure}] };
          if (options.afterClick) text = options.afterClick();
        }
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
