/**
 * Extract the first complete top-level JSON object from a model reply. Robust to markdown fences
 * and to any trailing prose or extra objects — it depth-tracks braces (respecting strings/escapes)
 * to find the first balanced object, rather than the naive first-`{`/last-`}` slice that breaks
 * when a reply contains more than one object. If the first balanced region is not valid JSON (e.g. a
 * prose `{action}` placeholder before the real payload), it resumes scanning for a later object.
 */
export function extractFirstJsonObject(text: string): unknown {
  return extractFirstBalanced(text, "{", "}");
}

/**
 * Extract the first complete top-level JSON array from a model reply, with the same fence/prose
 * tolerance and resume-on-parse-failure behaviour as {@link extractFirstJsonObject}.
 */
export function extractFirstJsonArray(text: string): unknown {
  return extractFirstBalanced(text, "[", "]");
}

/**
 * Scan `text` for the first balanced `open`…`close` region (respecting string literals and escapes)
 * that parses as JSON, resuming past earlier balanced regions that do not. When a balanced region
 * fails to parse, scanning resumes AFTER it — at the next sibling region — never inside it, so a
 * nested fragment (or a bracket living in a string) is never mistaken for the reply. A truncated
 * (never-closed) region likewise yields `undefined`. Returns `undefined` when no region parses — so
 * a non-JSON `open`…`close` pair before the real payload, or markdown fences around it, no longer
 * defeats extraction, while a malformed reply still fails closed (`undefined`) rather than fails open.
 */
function extractFirstBalanced(text: string, open: string, close: string): unknown {
  for (let from = 0; ; ) {
    const start = text.indexOf(open, from);
    if (start === -1) return undefined;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end === -1) return undefined; // unbalanced/truncated — no complete region here
    try {
      return JSON.parse(text.slice(start, end));
    } catch {
      from = end; // this region isn't JSON; resume after it, at the next sibling opener
    }
  }
}
