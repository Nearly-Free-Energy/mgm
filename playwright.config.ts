import { defineConfig, type PlaywrightTestOptions } from "@playwright/test";

// The browser smoke (e2e/): sign-in, home and a microgrid's households list
// on a 360 px touch screen, against the production build (`npm run build`
// first) and a local Supabase. docs/setup.md, "Browser smoke test".
// Chromium only; CI installs it in its own step.
const PORT = 3100;

// A phone: 360 px wide, touch as the primary pointer, so the
// `(pointer: coarse)` rules in globals.css apply.
const phone: Partial<PlaywrightTestOptions> = {
  viewport: { width: 360, height: 800 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
};

export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  // A pass on the retry is reported as flaky in the summary.
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    browserName: "chromium",
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/, teardown: "teardown", use: phone },
    { name: "teardown", testMatch: /auth\.teardown\.ts/ },
    {
      name: "narrow",
      testMatch: /\.spec\.ts$/,
      dependencies: ["setup"],
      use: { ...phone, storageState: "e2e/.auth/manager.json" },
    },
  ],
  webServer: {
    // Warns that standalone output prefers its own server; it serves normally.
    command: `npm run start -- -H 127.0.0.1 -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
