import { createHash } from "node:crypto";
import { beforeEach, afterEach, vi } from "vitest";

/** Fake timers cannot advance WebCrypto's native worker queue. Keep its exact SHA-256 result
 * but resolve on a microtask so clock-bound tests still measure browser polling, not native
 * worker scheduling. Real WebCrypto is covered in contract-identity and browser tests. */
export function useClockDigest(): void {
  let restore: (() => void) | undefined;
  beforeEach(() => {
    const spy = vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      if (algorithm !== "SHA-256") throw new Error("Unexpected digest algorithm");
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data as ArrayBuffer);
      const digest = createHash("sha256").update(bytes).digest();
      return Uint8Array.from(digest).buffer;
    });
    restore = () => spy.mockRestore();
  });
  afterEach(() => restore?.());
}
