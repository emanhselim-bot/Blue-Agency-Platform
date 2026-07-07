/**
 * Shared helpers for integration and E2E tests.
 *
 * Provides:
 *   adminClient()         — service-role client (bypasses RLS)
 *   anonClient()          — anon client (subject to RLS)
 *   createTestUser()      — sign up + return authenticated client
 *   createTestOrg()       — create org + return org_id
 *   cleanupTestData()     — delete test rows by email pattern
 *   generateTestEmail()   — unique email per test run
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL           = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY      = process.env.SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Prefix all test emails so cleanup can find them easily
const TEST_EMAIL_PREFIX = "test-suite-";
const TEST_EMAIL_DOMAIN = "@blue-agency-test.internal";

let _adminClient: SupabaseClient | null = null;

/** Service-role client — bypasses RLS. Use for setup/teardown only. */
export function adminClient(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return _adminClient;
}

/** Anonymous client — subject to all RLS policies. */
export function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Unique email for a specific test to avoid collisions between parallel runs. */
export function generateTestEmail(label: string): string {
  const ts = Date.now();
  return `${TEST_EMAIL_PREFIX}${label}-${ts}${TEST_EMAIL_DOMAIN}`;
}

export interface TestUser {
  id:     string;
  email:  string;
  client: SupabaseClient;
}

/**
 * Create a Supabase user via the admin API, then sign in and return
 * an authenticated client for that user.
 */
export async function createTestUser(
  email: string,
  password = "TestPassword1234!"
): Promise<TestUser> {
  const admin = adminClient();

  // Create user via admin API (bypasses email confirmation)
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr) throw new Error(`createTestUser failed: ${createErr.message}`);

  // Sign in as the user to get a real JWT
  const userClient = anonClient();
  const { data: session, error: signInErr } = await userClient.auth.signInWithPassword({
    email,
    password,
  });
  if (signInErr || !session.user) {
    throw new Error(`createTestUser sign-in failed: ${signInErr?.message}`);
  }

  return { id: session.user.id, email, client: userClient };
}

/**
 * Create an organization as the given user. Returns the new org_id.
 * Uses the create_organization RPC (SECURITY DEFINER, handles membership).
 */
export async function createTestOrg(
  userClient: SupabaseClient,
  name: string
): Promise<string> {
  const { data, error } = await userClient.rpc("create_organization", { org_name: name });
  if (error) throw new Error(`createTestOrg failed: ${error.message}`);
  return data as string;
}

/**
 * Add a user to an org with a given role (already accepted).
 * Uses service role so it bypasses the invitation flow.
 */
export async function addMemberToOrg(
  orgId:  string,
  userId: string,
  role:   "owner" | "admin" | "analyst" | "viewer"
): Promise<void> {
  const { error } = await adminClient()
    .from("organization_members")
    .insert({
      organization_id: orgId,
      user_id:         userId,
      role,
      accepted_at:     new Date().toISOString(),
    });
  if (error) throw new Error(`addMemberToOrg failed: ${error.message}`);
}

/**
 * Insert a test Shopify store row via service role.
 * access_token is a placeholder — tests don't call the real Shopify API.
 */
export async function insertTestShopifyStore(params: {
  orgId:      string;
  shopDomain: string;
  shopName?:  string;
  isActive?:  boolean;
  status?:    string;
}): Promise<string> {
  const { data, error } = await adminClient()
    .from("shopify_stores")
    .insert({
      organization_id: params.orgId,
      shop_domain:     params.shopDomain,
      shop_name:       params.shopName ?? params.shopDomain,
      access_token:    "test-access-token-placeholder",
      scopes:          "read_orders,read_products,read_analytics,read_inventory",
      is_active:       params.isActive ?? true,
      status:          params.status ?? "active",
      connected_at:    new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`insertTestShopifyStore failed: ${error.message}`);
  return data!.id;
}

/**
 * Insert a test Meta Business Manager row via service role.
 */
export async function insertTestMetaBM(params: {
  orgId:           string;
  businessId:      string;
  businessName?:   string;
  status?:         string;
  tokenExpiresAt?: string;
}): Promise<string> {
  const { data, error } = await adminClient()
    .from("meta_business_managers")
    .insert({
      organization_id:  params.orgId,
      business_id:      params.businessId,
      business_name:    params.businessName ?? `Test BM ${params.businessId}`,
      access_token:     "test-meta-access-token",
      token_expires_at: params.tokenExpiresAt ?? null,
      scopes:           ["ads_read", "ads_management"],
      status:           params.status ?? "active",
      last_verified_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`insertTestMetaBM failed: ${error.message}`);
  return data!.id;
}

/**
 * Delete all test users whose email matches the test prefix.
 * Call this in afterAll / global teardown.
 */
export async function cleanupTestUsers(): Promise<void> {
  const admin = adminClient();
  // List all users — Supabase admin API returns paginated results
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const testUsers = (data?.users ?? []).filter(u =>
    u.email?.startsWith(TEST_EMAIL_PREFIX) || u.email?.endsWith(TEST_EMAIL_DOMAIN)
  );
  for (const u of testUsers) {
    await admin.auth.admin.deleteUser(u.id);
  }
}

/**
 * Delete all rows in test tables that belong to orgs created by test users.
 * Cascades automatically via FK constraints.
 */
export async function cleanupTestOrgs(orgIds: string[]): Promise<void> {
  if (!orgIds.length) return;
  await adminClient()
    .from("organizations")
    .delete()
    .in("id", orgIds);
}
