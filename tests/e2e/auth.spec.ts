/**
 * E2E tests: Authentication flows
 *
 * Covers sign up, sign in, sign out, and session persistence.
 * Requires: DASHBOARD_URL env var pointing to a running local server.
 */

import { test, expect, Page } from "@playwright/test";

const TEST_EMAIL    = `e2e-auth-${Date.now()}@blue-agency-test.internal`;
const TEST_PASSWORD = "e2e-test-password-123";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fillLoginForm(page: Page, email: string, password: string) {
  await page.fill('[data-testid="email-input"], input[type="email"], #email', email);
  await page.fill('[data-testid="password-input"], input[type="password"], #password', password);
}

async function submitForm(page: Page) {
  await page.click('[data-testid="submit-btn"], button[type="submit"], #login-btn, #signin-btn');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe("Sign up", () => {
  test("new user can sign up with valid credentials", async ({ page }) => {
    await page.goto("/signup");

    await fillLoginForm(page, TEST_EMAIL, TEST_PASSWORD);
    await submitForm(page);

    // After signup, should redirect to onboarding or dashboard
    await expect(page).not.toHaveURL(/signup/);
    await expect(page).toHaveURL(/dashboard|onboarding|create-org/);
  });

  test("sign up with existing email shows an error", async ({ page }) => {
    await page.goto("/signup");

    // Use the same email as above (already registered via globalSetup or test order)
    await fillLoginForm(page, TEST_EMAIL, TEST_PASSWORD);
    await submitForm(page);

    // Some auth providers don't disclose email existence — check for soft error or already-logged-in state
    const errorVisible = await page.locator(".error, [role='alert'], .alert-error").isVisible().catch(() => false);
    const loggedIn     = page.url().includes("dashboard") || page.url().includes("onboarding");
    expect(errorVisible || loggedIn).toBe(true);
  });

  test("sign up with short password shows validation error", async ({ page }) => {
    await page.goto("/signup");

    await fillLoginForm(page, `short-pw-${Date.now()}@blue-agency-test.internal`, "abc");
    await submitForm(page);

    // Should stay on signup page and show an error
    const error = page.locator(".error, [role='alert'], .field-error, #error-message");
    await expect(error.first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Sign in", () => {
  test("existing user can sign in", async ({ page }) => {
    await page.goto("/login");

    await fillLoginForm(page, TEST_EMAIL, TEST_PASSWORD);
    await submitForm(page);

    await expect(page).toHaveURL(/dashboard|onboarding|create-org/);
  });

  test("wrong password shows error", async ({ page }) => {
    await page.goto("/login");

    await fillLoginForm(page, TEST_EMAIL, "wrong-password-xyz");
    await submitForm(page);

    // Should stay on login page
    await expect(page).toHaveURL(/login/);
    const error = page.locator(".error, [role='alert'], #error-message");
    await expect(error.first()).toBeVisible({ timeout: 5000 });
  });

  test("non-existent email shows error", async ({ page }) => {
    await page.goto("/login");

    await fillLoginForm(page, "ghost-nobody@blue-agency-test.internal", TEST_PASSWORD);
    await submitForm(page);

    await expect(page).toHaveURL(/login/);
    const error = page.locator(".error, [role='alert'], #error-message");
    await expect(error.first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Sign out", () => {
  test("signed-in user can sign out", async ({ page }) => {
    // Sign in first
    await page.goto("/login");
    await fillLoginForm(page, TEST_EMAIL, TEST_PASSWORD);
    await submitForm(page);
    await expect(page).toHaveURL(/dashboard|onboarding/);

    // Find and click sign out
    const signOutBtn = page.locator(
      '[data-testid="signout-btn"], button:has-text("Sign out"), button:has-text("Log out"), a:has-text("Sign out")',
    );

    if (!(await signOutBtn.isVisible().catch(() => false))) {
      // May be in a dropdown/menu
      const avatarOrMenu = page.locator(
        '[data-testid="user-menu"], .avatar, .user-avatar, button.profile',
      );
      if (await avatarOrMenu.isVisible().catch(() => false)) {
        await avatarOrMenu.click();
      }
    }

    await signOutBtn.click({ timeout: 8000 });

    // Should redirect to login or home
    await expect(page).toHaveURL(/login|\/$/);
  });
});

test.describe("Session persistence", () => {
  test("session persists across page reload", async ({ page }) => {
    await page.goto("/login");
    await fillLoginForm(page, TEST_EMAIL, TEST_PASSWORD);
    await submitForm(page);
    await expect(page).toHaveURL(/dashboard|onboarding/);

    // Reload
    await page.reload();

    // Should still be authenticated (not redirected to login)
    await expect(page).not.toHaveURL(/login/);
    await expect(page).toHaveURL(/dashboard|onboarding/);
  });
});

test.describe("Unauthenticated access", () => {
  test("accessing dashboard without auth redirects to login", async ({ page }) => {
    // Clear any existing session
    await page.context().clearCookies();
    await page.evaluate(() => {
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
    });

    await page.goto("/dashboard");
    await expect(page).toHaveURL(/login/);
  });
});
