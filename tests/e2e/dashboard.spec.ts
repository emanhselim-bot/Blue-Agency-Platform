/**
 * E2E tests: Dashboard
 *
 * Covers KPI cards, charts, date filters, account switching, and
 * the All Accounts summary view.
 */

import { test, expect, Page, BrowserContext } from "@playwright/test";

// ── Auth helper ───────────────────────────────────────────────────────────────

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.fill('input[type="email"], #email', email);
  await page.fill('input[type="password"], #password', password);
  await page.click('button[type="submit"], #login-btn, #signin-btn');
  await page.waitForURL(/dashboard|onboarding/, { timeout: 10_000 });
}

// ── Test data from globalSetup ────────────────────────────────────────────────

const OWNER_EMAIL    = process.env.E2E_OWNER_EMAIL    ?? "e2e-owner@blue-agency-test.internal";
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD ?? "e2e-test-password-123";

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe("Dashboard layout", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
    await page.goto("/dashboard");
  });

  test("dashboard loads without errors", async ({ page }) => {
    // No console errors about uncaught exceptions
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).toBeVisible();

    const criticalErrors = errors.filter(
      (e) => !e.includes("ResizeObserver") && !e.includes("Non-Error promise rejection"),
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test("header / navbar is visible", async ({ page }) => {
    const nav = page.locator("nav, header, .navbar, .sidebar");
    await expect(nav.first()).toBeVisible();
  });

  test("refresh button is present", async ({ page }) => {
    const refresh = page.locator(
      '[data-testid="refresh-btn"], button:has-text("Refresh"), button:has-text("↻")',
    );
    await expect(refresh.first()).toBeVisible({ timeout: 8_000 });
  });
});

test.describe("KPI cards", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");
  });

  test("at least one KPI card is rendered", async ({ page }) => {
    const cards = page.locator(
      '.kpi-card, .metric-card, [data-testid="kpi-card"], .stat-card, .dashboard-card',
    );
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });
  });

  test("KPI cards contain numeric values", async ({ page }) => {
    const cardValues = page.locator('.kpi-value, .metric-value, [data-testid="kpi-value"]');
    if (await cardValues.count() > 0) {
      const firstValue = await cardValues.first().textContent();
      // Should contain a digit or currency symbol
      expect(firstValue).toMatch(/[\d$€£¥]/);
    }
  });
});

test.describe("Charts", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");
  });

  test("chart canvas or chart container renders", async ({ page }) => {
    const chart = page.locator(
      'canvas, .chart-container, [data-testid="chart"], .recharts-wrapper, svg.chart',
    );
    const count = await chart.count();
    // Either a chart renders or a "no data" placeholder is shown
    const noData = page.locator(".no-data, .empty-state, :has-text('No data')");
    const noDataCount = await noData.count();

    expect(count > 0 || noDataCount > 0).toBe(true);
  });
});

test.describe("Date range filter", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");
  });

  test("date filter controls are present", async ({ page }) => {
    const dateFilter = page.locator(
      'select[name*="date"], select[name*="range"], [data-testid="date-filter"], ' +
      'button:has-text("Last 7"), button:has-text("Last 30"), .date-range',
    );
    await expect(dateFilter.first()).toBeVisible({ timeout: 8_000 });
  });

  test("changing date range triggers data reload", async ({ page }) => {
    const dateSelects = page.locator(
      'select[name*="date"], select[name*="range"], [data-testid="date-filter"]',
    );

    if (await dateSelects.count() > 0) {
      const networkRequests: string[] = [];
      page.on("request", (req) => {
        if (req.url().includes("functions/v1/meta-data") || req.url().includes("supabase")) {
          networkRequests.push(req.url());
        }
      });

      const select = dateSelects.first();
      const options = await select.locator("option").allTextContents();
      if (options.length > 1) {
        await select.selectOption({ index: 1 });
        await page.waitForTimeout(1500);
        expect(networkRequests.length).toBeGreaterThan(0);
      }
    } else {
      // Date filter may be buttons
      const rangeBtn = page.locator('button:has-text("Last 30"), button:has-text("30d")');
      if (await rangeBtn.isVisible().catch(() => false)) {
        const networkRequests: string[] = [];
        page.on("request", (req) => { networkRequests.push(req.url()); });
        await rangeBtn.click();
        await page.waitForTimeout(1500);
        expect(networkRequests.length).toBeGreaterThan(0);
      }
    }
  });
});

test.describe("Account switcher", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");
  });

  test("account selector is visible", async ({ page }) => {
    const selector = page.locator(
      'select[name*="account"], [data-testid="account-select"], ' +
      '.account-switcher, select#account-select',
    );
    await expect(selector.first()).toBeVisible({ timeout: 8_000 });
  });

  test("'All Accounts' option is available", async ({ page }) => {
    const allAccounts = page.locator(
      ':has-text("All Accounts"), option:has-text("All"), [data-value="all"]',
    );
    await expect(allAccounts.first()).toBeVisible({ timeout: 8_000 });
  });
});

test.describe("All Accounts view", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");
  });

  test("selecting All Accounts loads summary view", async ({ page }) => {
    // Click or select "All Accounts"
    const allAccounts = page.locator(
      'option:has-text("All"), [data-value="all"], button:has-text("All Accounts")',
    );

    if (await allAccounts.count() > 0) {
      const select = page.locator('select[name*="account"], select#account-select');
      if (await select.count() > 0) {
        await select.selectOption({ label: /all/i });
      } else {
        await allAccounts.first().click();
      }

      await page.waitForTimeout(1500);

      // Should show a summary card or table, not an error
      const error = page.locator(".error-state, .error-message");
      const hasError = await error.isVisible().catch(() => false);
      expect(hasError).toBe(false);
    }
  });
});
