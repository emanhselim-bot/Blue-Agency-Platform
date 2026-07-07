import { defineConfig, devices } from "@playwright/test";
import { resolve } from "path";

/**
 * Playwright E2E configuration.
 *
 * Prerequisites before running:
 *   1. supabase start                    (local Supabase on :54321)
 *   2. Serve dashboard.html on APP_URL   (e.g. npx serve . -p 3000)
 *   3. supabase functions serve          (optional — for OAuth flows)
 *
 * Environment variables (copy .env.test.example → .env.test):
 *   DASHBOARD_URL          http://localhost:3000
 *   SUPABASE_URL           http://localhost:54321
 *   SUPABASE_ANON_KEY      <local anon key>
 *   SUPABASE_SERVICE_ROLE_KEY  <local service role key>
 *   TEST_USER_EMAIL        test@example.com
 *   TEST_USER_PASSWORD     TestPass1234!
 */
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/test-results",

  // Fail fast in CI; run all in local dev
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,

  reporter: [
    ["html", { outputFolder: "e2e/playwright-report", open: "never" }],
    ["list"],
  ],

  use: {
    baseURL: process.env.DASHBOARD_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "on-first-retry",

    // Longer navigation timeout — dashboard does async auth check on load
    navigationTimeout: 10_000,
    actionTimeout: 8_000,
  },

  projects: [
    {
      name: "setup",
      testMatch: /e2e\/.*\.setup\.ts/,
    },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
    // Uncomment to add more browsers in CI:
    // { name: "firefox",       use: { ...devices["Desktop Firefox"] } },
    // { name: "Mobile Chrome", use: { ...devices["Pixel 5"] } },
  ],

  // Seed test accounts before the suite and clean up after
  globalSetup: resolve(__dirname, "setup/global-setup.ts"),
  globalTeardown: resolve(__dirname, "setup/global-teardown.ts"),
});
