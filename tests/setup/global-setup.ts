/**
 * Playwright global setup — runs once before all E2E tests.
 *
 * Creates the test user accounts that E2E specs log in as.
 * Users are seeded into the local Supabase instance.
 */
import { config } from "dotenv";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";

export default async function globalSetup() {
  // Load .env.test from tests directory
  config({ path: resolve(__dirname, "../.env.test") });

  const url  = process.env.SUPABASE_URL!;
  const key  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!url || !key) {
    console.warn("[global-setup] SUPABASE_URL or SERVICE_ROLE_KEY not set — E2E tests will fail");
    return;
  }

  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const accounts = [
    { email: process.env.TEST_OWNER_EMAIL!,   password: process.env.TEST_OWNER_PASSWORD!   },
    { email: process.env.TEST_ADMIN_EMAIL!,   password: process.env.TEST_ADMIN_PASSWORD!   },
    { email: process.env.TEST_ANALYST_EMAIL!, password: process.env.TEST_ANALYST_PASSWORD! },
    { email: process.env.TEST_VIEWER_EMAIL!,  password: process.env.TEST_VIEWER_PASSWORD!  },
  ].filter(a => a.email && a.password);

  for (const { email, password } of accounts) {
    // Check if user already exists
    const { data: existing } = await admin.auth.admin.listUsers();
    const exists = existing?.users.some(u => u.email === email);
    if (exists) {
      console.log(`[global-setup] User already exists: ${email}`);
      continue;
    }

    const { error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) {
      console.error(`[global-setup] Failed to create ${email}:`, error.message);
    } else {
      console.log(`[global-setup] Created test user: ${email}`);
    }
  }
}
