import { defineConfig } from "vitest/config";

// The default suite is pure and needs no browser: `test/browser/**` drives headless Chromium and is
// run on its own (`npm run test:browser`), so a clone without Playwright's chromium still gets a
// green `npm test`. CI runs both, as separate jobs.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "test/browser/**"],
  },
});
