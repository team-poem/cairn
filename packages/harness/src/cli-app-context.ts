/** Explicit local file loading only. The engine never discovers or fetches app descriptions. */
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { MAX_APP_CONTEXT_BYTES, validateAppContext } from "./index.js";
import { flagStr, type Flags } from "./cli-args.js";

export async function appContextFromFlags(flags: Flags): Promise<string | undefined> {
  if (!flags.has("app-context")) return undefined;
  const path = flagStr(flags, "app-context");
  if (!path?.trim()) throw new Error("--app-context requires a local UTF-8 file path");
  // A FIFO must not wait for a writer before fstat can reject it. Regular files ignore NONBLOCK.
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await file.stat()).isFile()) throw new Error("--app-context requires a regular file");
    const buffer = Buffer.alloc(MAX_APP_CONTEXT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_APP_CONTEXT_BYTES) throw new Error(`--app-context must not exceed ${MAX_APP_CONTEXT_BYTES} UTF-8 bytes`);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)); }
    catch { throw new Error("--app-context requires valid UTF-8"); }
    // Preserve nonblank input (including a BOM) until the engine substitutes configured secrets.
    return validateAppContext(text) === undefined ? undefined : text;
  } finally { await file.close(); }
}
