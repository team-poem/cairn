/**
 * Extract the first complete top-level JSON object from a model reply. Robust to markdown fences
 * and to any trailing prose or extra objects — it depth-tracks braces (respecting strings/escapes)
 * to find the first balanced object, rather than the naive first-`{`/last-`}` slice that breaks
 * when a reply contains more than one object.
 */
export function extractFirstJsonObject(text: string): unknown {
  const s = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const start = s.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(s.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
