/**
 * Playwright global teardown — runs once after all E2E specs.
 *
 * Deletes the shared E2E test users and their org.
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env.test") });

const SUPABASE_URL     = process.env.SUPABASE_URL             ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const E2E_EMAILS = [
  "e2e-owner@blue-agency-test.internal",
  "e2e-analyst@blue-agency-test.internal",
  "e2e-viewer@blue-agency-test.internal",
];

export default async function globalTeardown() {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Delete org (cascades to members, stores, etc.)
  if (process.env.E2E_ORG_ID) {
    await admin.from("organizations").delete().eq("id", process.env.E2E_ORG_ID);
  }

  // Delete test users
  const { data: allUsers } = await admin.auth.admin.listUsers();
  for (const email of E2E_EMAILS) {
    const user = allUsers?.users.find((u: any) => u.email === email);
    if (user) {
      await admin.auth.admin.deleteUser(user.id);
    }
  }

  console.log("✅ E2E global teardown complete");
}
