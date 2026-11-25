import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { ChromeClickIdentity } from "../../src/adapters/drivers/chrome-click-identity.js";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({channel: "chrome"}).catch(() => chromium.launch()); });
afterAll(async () => { await browser?.close(); });

function prepare(page: Page, uid: string) {
  const receipt = new ChromeClickIdentity(async (source, uids) =>
    JSON.stringify(await page.evaluate(`(${source})(...${JSON.stringify(uids ?? [])}.map(id => document.getElementById(id)))`)));
  return receipt.prepare(uid).then(() => receipt);
}
const html = '<button id="one">Same</button><button id="two">Same</button>';
test("same DOM node across changing handles, separate same-name peers and new documents", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    const click = async (id: string) => {
      const receipt = await prepare(page, id);
      await page.locator("#" + id).click();
      await receipt.finish();
      expect(receipt.confirmed).toBeTypeOf("string");
      return receipt.confirmed;
    };
    const original = await click("one");
    await page.locator("#one").evaluate(el => { el.id = "rotated"; });
    expect(await click("rotated")).toBe(original);
    expect(await click("two")).not.toBe(original);
    await page.locator("#rotated").evaluate(el => el.replaceWith(el.cloneNode(true)));
    expect(await click("rotated")).not.toBe(original);
    await page.goto("data:text/html," + encodeURIComponent(html));
    expect(await click("one")).not.toBe(original);
  } finally { await page.close(); }
});

test("a substituted UID, synthetic click, multiple trusted events or navigation cannot confirm a node", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    const assertUnknown = async (act: () => Promise<unknown>) => {
      const receipt = await prepare(page, "one");
      await act();
      await receipt.finish();
      expect(receipt.confirmed).toBeUndefined();
    };
    await assertUnknown(() => page.locator("#two").click());
    await assertUnknown(() => page.evaluate("document.getElementById('one').click()"));
    await assertUnknown(() => page.locator("#one").dblclick());
    await assertUnknown(async () => {
      await page.locator("#one").click();
      await page.goto("data:text/html," + encodeURIComponent(html));
    });
  } finally { await page.close(); }
});
