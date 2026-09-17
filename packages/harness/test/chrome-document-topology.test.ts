// file: packages/harness/test/chrome-document-topology.test.ts
import { expect, test } from "vitest";
import { documentTopology } from "../src/adapters/drivers/chrome-documents.js";
import { parseSnapshotRows } from "../src/adapters/drivers/chrome.js";

test("documentTopologyVirtualUids: structural parsing covers unnamed empty frames without promoting scaffolding or rejecting virtual UID aliases", () => {
  const raw = 'uid=1_0 RootWebArea "Main"\n  uid=1_1 ignored\n    uid=1_2 button "Save"\n      uid=1_3 InlineTextBox "Save"\n    uid=1_4 Iframe\n      uid=1_5 RootWebArea url="https://frame.test/"\n        uid=1_6 ignored\n    uid=1_7 button "Save"\n      uid=1_3 InlineTextBox "Save"';
  const topology = documentTopology(raw);
  expect(topology.valid).toBe(true);
  expect(topology.framed).toBe(true);
  expect(topology.documents).toEqual([{ uid: "1_0" }, { uid: "1_5", parent: 0, owner: "1_4" }]);
  expect(topology.membership.get("1_4")).toBe(0);
  expect(topology.membership.get("1_5")).toBe(1);
  expect(parseSnapshotRows(raw).filter(row => row.role !== "InlineTextBox")).toEqual([
    { uid: "1_0", role: "RootWebArea", name: "Main" },
    { uid: "1_2", role: "button", name: "Save" },
    { uid: "1_7", role: "button", name: "Save" },
  ]);
  for (const unsupported of ['uid=1 RootWebArea "Main"\n  uid=2 Iframe', 'uid=1 RootWebArea "Main"\n  uid=2 RootWebArea']) {
    expect(documentTopology(unsupported)).toMatchObject({ framed: true, valid: false });
  }
});
