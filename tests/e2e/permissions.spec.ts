/**
 * E2E tests: Role-based UI permissions
 *
 * Verifies that owners see management controls that viewers do not,
 * and that analysts see analytics but not configuration.
 *
 * Requires E2E_OWNER_EMAIL, E2E_VIEWER_EMAIL, E2E_ANALYST_EMAIL in env.
 */

import { test, expect, Page } from "@playwright/test";

// ── Credentials (set by globalSetup or .env.test) ────────────────────────────

const OWNER_EMAIL    = process.env.E2E_OWNER_EMAIL    ?? "e2e-owner@blue-agency-test.internal";
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD ?? "e2e-test-password-123";
const VIEWER_EMAIL   = process.env.E2E_VIEWER_EMAIL   ?? "e2e-viewer@blue-agency-test.internal";
const VIEWER_PASSWORD = process.env.E2E_VIEWER_PASSWORD ?? "e2e-test-password-123";
const ANALYST_EMAIL  = process.env.E2E_ANALYST_EMAIL  ?? "e2e-analyst@blue-agency-test.internal";
const ANALYST_PASSWORD = process.env.E2E_ANALYST_PASSWORD ?? "e2e-test-password-123";

// ── Helper ───────────────────────────────────────────────────────────────────

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.fill('input[type="email"], #email', email);
  await page.fill('input[type="password"], #password', password);
  await page.click('button[type="submit"], #login-btn, #signin-btn');
  await page.waitForURL(/dashboard|onboarding/, { timeout: 10_000 });
}

async function goToSettings(page: Page) {
  const settingsLink = page.locator(
    'a[href*="settings"], [data-testid="settings-link"], nav a:has-text("Settings")',
  );
  if (await settingsLink.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await settingsLink.click();
    await page.waitForLoadState("networkidle");
  } else {
    await page.goto("/settings");
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe("Owner permissions", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  });

  test("owner sees Settings navigation item", async ({ page }) => {
    const settingsLink = page.locator(
      'a[href*="settings"], [data-testid="settings-link"], nav a:has-text("Settings")',
    );
    await expect(settingsLink.first()).toBeVisible({ timeout: 8_000 });
  });

  test("owner can access settings page", async ({ page }) => {
    await goToSettings(page);
    // Should not be redirected or see access-denied
    const denied = page.locator(':has-text("Access denied"), :has-text("Permission denied"), .error-403');
    const hasDenied = await denied.isVisible().catch(() => false);
    expect(hasDenied).toBe(false);
  });

  test("owner sees integration connect buttons", async ({ page }) => {
    await goToSettings(page);

    const connectBtn = page.locator(
      'button:has-text("Connect"), button:has-text("Add"), [data-testid="connect-btn"]',
    );
    const count = await connectBtn.count();
    expect(count).toBeGreaterThan(0);
  });

  test("owner can see member management section", async ({ page }) => {
    await goToSettings(page);

    const membersSection = page.locator(
      ':has-text("Members"), :has-text("Team"), [data-testid="members-section"]',
    );
    await expect(membersSection.first()).toBeVisible({ timeout: 8_000 });

    const inviteBtn = page.locator(
      'button:has-text("Invite"), [data-testid="invite-btn"]',
    );
    await expect(inviteBtn.first()).toBeVisible({ timeout: 5_000 });
  });
});

test.describe("Viewer permissions", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, VIEWER_EMAIL, VIEWER_PASSWORD);
  });

  test("viewer can see dashboard (read access)", async ({ page }) => {
    await page.goto("/dashboard");
    // Should load, not be blocked
    const denied = page.locator(':has-text("Access denied"), :has-text("Not authorized")');
    const hasDenied = await denied.isVisible({ timeout: 5_000 }).catch(() => false);
    expect(hasDenied).toBe(false);
  });

  test("viewer does not see Settings link (or settings are read-only)", async ({ page }) => {
    const settingsLink = page.locator(
      'nav a[href*="settings"], [data-testid="settings-link"]',
    );
    const isVisible = await settingsLink.isVisible({ timeout: 3_000 }).catch(() => false);

    if (isVisible) {
      // If settings link exists, navigate and check for disabled/read-only state
      await settingsLink.click();
      await page.waitForLoadState("networkidle");

      const connectBtn = page.locator('button:has-text("Connect"), [data-testid="connect-btn"]');
      const isEnabled  = await connectBtn.isEnabled().catch(() => false);
      expect(isEnabled).toBe(false);
    } else {
      // Settings link hidden from viewers — correct behavior
      expect(isVisible).toBe(false);
    }
  });

  test("viewer does not see Invite Members button", async ({ page }) => {
    await goToSettings(page);

    const inviteBtn = page.locator(
      'button:has-text("Invite"), [data-testid="invite-btn"]',
    );
    const isVisible = await inviteBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    expect(isVisible).toBe(false);
  });
});

test.describe("Analyst permissions", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, ANALYST_EMAIL, ANALYST_PASSWORD);
  });

  test("analyst can view dashboard analytics", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    // Dashboard loads for analyst
    const denied = page.locator(':has-text("Access denied"), :has-text("Not authorized")');
    const hasDenied = await denied.isVisible({ timeout: 5_000 }).catch(() => false);
    expect(hasDenied).toBe(false);
  });

  test("analyst cannot add/remove integrations", async ({ page }) => {
    await goToSettings(page);

    const disconnectBtn = page.locator(
      'button:has-text("Disconnect"), button:has-text("Remove integration")',
    );

    if (await disconnectBtn.count() > 0) {
      const isEnabled = await disconnectBtn.first().isEnabled().catch(() => false);
      expect(isEnabled).toBe(false);
    }
    // If no disconnect button is visible at all, that's also correct for analysts
  });
});
