/** AX scaffolding is not an independent DOM/action target, even without host ownership. */
export const virtualAXRoles = new Set(["InlineTextBox", "ListMarker", "ignored"]);

/** Keep real descendants and document topology; never map a virtual UID to an ancestor. */
export function stripVirtualAXRows(raw: string): string {
  const lines = raw.split("\n");
  const rows = lines.map(line => line.match(/uid=(\S+)\s+(\w+)/));
  const virtualUids = new Set(rows.filter(row => row && virtualAXRoles.has(row[2]!)).map(row => row![1]!));
  return lines.filter((_, index) => {
    const row = rows[index];
    if (!row) return true;
    // Generated StaticText shares the unresolved glyph-run UID in verbose MCP
    // output. Remove that row too, not a real control with its computed name.
    return !virtualAXRoles.has(row[2]!) && !(row[2] === "StaticText" && virtualUids.has(row[1]!));
  }).join("\n");
}
