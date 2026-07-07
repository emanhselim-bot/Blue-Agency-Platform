/**
 * Vitest global setup — runs before every test file.
 * Loads .env.test into process.env so integration tests can reach
 * the local Supabase instance without extra config.
 */
import { config } from "dotenv";
import { resolve } from "path";

// Load test-specific env (project root tests/.env.test)
config({ path: resolve(__dirname, "../.env.test"), override: false });

// Validate required env vars for integration tests so failures are obvious
const required = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
];

for (const key of required) {
  if (!process.env[key]) {
    console.warn(
      `[vitest-setup] WARNING: ${key} is not set. ` +
      `Integration tests will fail. Copy .env.test.example → .env.test`
    );
  }
}
