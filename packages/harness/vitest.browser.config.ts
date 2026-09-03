import { defineConfig } from "vitest/config";

// Only the layout-dependent suite. Chromium start-up dominates each file, so these run serially
// with a longer timeout than the pure tests would ever need.
export default defineConfig({
  test: {
    include: ["test/browser/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
