import { defineConfig, type PlaywrightTestOptions } from "@playwright/test";

// The browser smoke (e2e/): sign-in, home, a microgrid's tenants list
// and a community's invoice branding page (logo and PDF preview) on a 360 px
// touch screen, as an organization manager; and a tenant's sign-in and,
// once RFC mgm#197 PR 5 releases them, the tenant's usage month and day on
// a synthetic meter. Against the production build (`npm run build` first)
// and a local Supabase. docs/setup.md, "Browser smoke test".
// Chromium only; CI installs it in its own step.
const PORT = 3100;
const ORIGIN = `http://127.0.0.1:${PORT}`;

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
    baseURL: ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/, teardown: "teardown", use: phone },
    { name: "teardown", testMatch: /auth\.teardown\.ts/ },
    {
      name: "narrow",
      testMatch: /\.spec\.ts$/,
      testIgnore: /tenant\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...phone, storageState: "e2e/.auth/manager.json" },
    },
    // The tenant signs in with the rows the setup project created, and the
    // setup project's teardown runs after this one too.
    { name: "tenant-setup", testMatch: /tenant\.setup\.ts/, dependencies: ["setup"], use: phone },
    {
      name: "tenant",
      testMatch: /tenant\.spec\.ts/,
      dependencies: ["setup", "tenant-setup"],
      use: { ...phone, storageState: "e2e/.auth/tenant.json" },
    },
  ],
  webServer: {
    // Warns that standalone output prefers its own server; it serves normally.
    command: `npm run start -- -H 127.0.0.1 -p ${PORT}`,
    // Sign-in links go to the local Supabase's mail catcher, where
    // e2e/fixtures.ts reads them (RFC #186). Playwright gives the server
    // exactly this environment, so the rest of process.env is spread in.
    // The link is built from MGM_APP_URL, so it is always this server:
    // a value from the shell would send the browser to another origin.
    env: {
      ...(process.env as Record<string, string>),
      MGM_APP_URL: ORIGIN,
      MGM_SMTP_URL: process.env.MGM_SMTP_URL ?? "smtp://127.0.0.1:54325",
      MGM_MAIL_FROM: process.env.MGM_MAIL_FROM ?? "MGM <no-reply@smoke.test>",
      // The tenant's meter is on a SYNTHETIC-EDGE- edge (e2e/fixtures.ts),
      // which only the fixture metering provider serves. It serves no other
      // microgrid: the manager's have no edges.
      MGM_METERING_FIXTURES: "1",
    },
    url: `${ORIGIN}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
