/**
 * Playwright global teardown — runs once after all E2E tests.
 * Cleans up any test data created during the E2E run.
 */
export default async function globalTeardown() {
  // E2E tests use pre-seeded accounts that persist between runs.
  // Individual test data (orgs, stores) is cleaned up within each spec's afterAll.
  console.log("[global-teardown] E2E suite complete.");
}
