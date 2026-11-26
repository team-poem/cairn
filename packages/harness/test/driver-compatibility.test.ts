import { describe, expect, it } from "vitest";
import { discover } from "../src/index.js";
import { resolveCollectionTarget } from "../src/core/collection.js";
import type { LlmClient, Target } from "../src/index.js";
import { AttributeDriver } from "./support/driver-2.9.8.js";
import { authoredRootName, describeCollection } from "./support/host-2.9.8.js";

const links: Target = { collection: { links: { scope: ".grid", member: ":scope > a" }, order: "dom", index: 1, expectedCount: 3 } };

describe("a Driver written against the 2.9.8 port", () => {
  it("is refused a link collection before it observes or clicks anything", async () => {
    const driver = new AttributeDriver();
    await expect(resolveCollectionTarget(driver, links)).rejects.toMatchObject({ code: "unsupported" });
    expect(driver.calls).toEqual([]);
  });

  it("is refused a link destination check in discovery before the run starts", async () => {
    const driver = new AttributeDriver();
    const llm: LlmClient = { id: "forbidden", complete: async () => { throw new Error("discovery must not start"); } };
    await expect(discover("Open the second post", { driver, llm, baseUrl: "https://app/posts", selections: [{
      version: 1, id: "second-post", target: links, verify: { source: { kind: "href" }, destination: { kind: "location" } },
    }] })).rejects.toMatchObject({ code: "unsupported" });
    expect(driver.calls).toEqual([]);
  });
});

describe("host code written against 2.9.8", () => {
  it("reads the role form validateCollectionTarget returns", () => {
    expect(describeCollection({ root: { role: "listbox", name: "Sizes" }, itemRole: "option", target: { role: "option" }, order: "dom", index: 1 }))
      .toBe("listbox:Sizes:option:option");
    expect(authoredRootName()).toBe("Results");
  });
});
