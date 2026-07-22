/**
 * Engine version, read once from package.json. Lives OUTSIDE core/ deliberately: core stays free
 * of node builtins so the browser entry (`cairn-engine/browser`) bundles clean — `startTrace`
 * takes the version as a parameter, and only the Node assembly layers (run/suite) read this.
 */
import { createRequire } from "node:module";

/** dist/version.js → ../package.json (same shape from src). */
export const ENGINE_VERSION: string = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;
