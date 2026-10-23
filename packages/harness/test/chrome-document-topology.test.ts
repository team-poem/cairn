// file: packages/harness/test/chrome-document-topology.test.ts
import { expect, test } from "vitest";
import { documentTopology } from "../src/adapters/drivers/chrome-documents.js";
import { parseSnapshotRows } from "../src/adapters/drivers/chrome.js";
import { stripVirtualAXRows } from "../src/adapters/drivers/chrome-ax.js";

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

test("virtual normalization preserves nested document ancestry and does not hide invalid real topology", () => {
  const raw = 'uid=root RootWebArea "Main"\n  uid=body ignored\n    uid=marker ListMarker "bullet"\n      uid=virtual ignored\n' +
    '    uid=text StaticText "App item"\n      uid=virtual InlineTextBox "App item"\n' +
    '    uid=frame Iframe\n      uid=child RootWebArea "Child"\n        uid=wrapper ignored\n' +
    '          uid=virtual StaticText "Generated"\n          uid=action button "App action"';
  const clean = stripVirtualAXRows(raw);
  expect(clean).not.toMatch(/ListMarker|InlineTextBox|ignored|Generated/);
  expect(clean).toContain('uid=text StaticText "App item"');
  expect(documentTopology(clean)).toMatchObject({ valid: true, framed: true,
    documents: [{ uid: "root" }, { uid: "child", parent: 0, owner: "frame" }] });
  expect(documentTopology(clean).membership.get("action")).toBe(1);
  for (const invalid of [
    'uid=root RootWebArea "Main"\n  uid=frame Iframe',
    'uid=root RootWebArea "Main"\n  uid=child RootWebArea "Orphan"',
    'uid=root RootWebArea "Main"\n  uid=action button "A"\n  uid=action button "B"',
  ]) expect(documentTopology(stripVirtualAXRows(invalid)).valid).toBe(false);
});
