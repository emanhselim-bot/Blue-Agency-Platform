/**
 * Playwright global setup — runs once before all E2E specs.
 *
 * Creates shared test users (owner, analyst, viewer) and a shared org
 * so each spec file can sign in immediately without provisioning its own users.
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env.test") });

const SUPABASE_URL     = process.env.SUPABASE_URL             ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY         = process.env.SUPABASE_ANON_KEY         ?? "";

const OWNER_EMAIL    = "e2e-owner@blue-agency-test.internal";
const ANALYST_EMAIL  = "e2e-analyst@blue-agency-test.internal";
const VIEWER_EMAIL   = "e2e-viewer@blue-agency-test.internal";
const E2E_PASSWORD   = "e2e-test-password-123";
const STORE_DOMAIN   = `e2e-store-${Date.now()}.myshopify.com`;

export default async function globalSetup() {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // ── Create users ────────────────────────────────────────────────────────────

  const users = [OWNER_EMAIL, ANALYST_EMAIL, VIEWER_EMAIL];

  const userIds: Record<string, string> = {};
  for (const email of users) {
    // Delete if already exists from a prior run
    const { data: existing } = await admin.auth.admin.listUsers();
    const found = existing?.users.find((u: any) => u.email === email);
    if (found) {
      await admin.auth.admin.deleteUser(found.id);
    }

    const { data: created } = await admin.auth.admin.createUser({
      email,
      password:      E2E_PASSWORD,
      email_confirm: true,
    });
    userIds[email] = created.user!.id;
  }

  // ── Owner creates org ────────────────────────────────────────────────────────

  const ownerAnon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: ownerSession } = await ownerAnon.auth.signInWithPassword({
    email:    OWNER_EMAIL,
    password: E2E_PASSWORD,
  });

  const ownerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${ownerSession.session!.access_token}` } },
  });

  const { data: orgId } = await ownerClient.rpc("create_organization", {
    org_name: "E2E Test Org",
  });

  // ── Add analyst and viewer ───────────────────────────────────────────────────

  await admin.from("organization_members").insert([
    {
      organization_id: orgId,
      user_id:         userIds[ANALYST_EMAIL],
      role:            "analyst",
      accepted_at:     new Date().toISOString(),
    },
    {
      organization_id: orgId,
      user_id:         userIds[VIEWER_EMAIL],
      role:            "viewer",
      accepted_at:     new Date().toISOString(),
    },
  ]);

  // ── Seed a Shopify store ─────────────────────────────────────────────────────

  const { data: store } = await admin
    .from("shopify_stores")
    .insert({
      organization_id: orgId,
      shop_domain:     STORE_DOMAIN,
      shop_name:       "E2E Test Store",
      access_token:    "e2e-test-access-token",
      scopes:          "read_orders,write_orders",
      connected_at:    new Date().toISOString(),
      status:          "active",
      is_active:       true,
    })
    .select("id")
    .single();

  // ── Seed an expired Meta BM (for token-expiry tests) ─────────────────────────

  const { data: bm } = await admin
    .from("meta_business_managers")
    .insert({
      organization_id:  orgId,
      meta_business_id: `e2e-expired-bm-${Date.now()}`,
      business_name:    "E2E Expired BM",
      access_token:     "expired-meta-token",
      status:           "expired",
      token_expires_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 70).toISOString(), // 70 days ago
    })
    .select("id")
    .single();

  const { data: adAccount } = await admin
    .from("meta_ad_accounts")
    .insert({
      organization_id:     orgId,
      business_manager_id: bm!.id,
      meta_account_id:     `act_e2e_expired_${Date.now()}`,
      account_name:        "E2E Expired Account",
      currency:            "USD",
      is_active:           true,
    })
    .select("id")
    .single();

  // ── Export env vars for specs ────────────────────────────────────────────────

  process.env.E2E_OWNER_EMAIL          = OWNER_EMAIL;
  process.env.E2E_OWNER_PASSWORD       = E2E_PASSWORD;
  process.env.E2E_ANALYST_EMAIL        = ANALYST_EMAIL;
  process.env.E2E_ANALYST_PASSWORD     = E2E_PASSWORD;
  process.env.E2E_VIEWER_EMAIL         = VIEWER_EMAIL;
  process.env.E2E_VIEWER_PASSWORD      = E2E_PASSWORD;
  process.env.E2E_ORG_ID               = orgId;
  process.env.E2E_STORE_DOMAIN         = STORE_DOMAIN;
  process.env.E2E_STORE_ID             = store!.id;
  process.env.E2E_EXPIRED_ACCOUNT_NAME = "E2E Expired Account";
  process.env.E2E_EXPIRED_ACCT_ID      = adAccount!.id;

  console.log("✅ E2E global setup complete");
  console.log(`   Org: ${orgId}`);
  console.log(`   Store: ${STORE_DOMAIN} (${store!.id})`);
  console.log(`   Expired BM: ${bm!.id}`);
}
