/**
 * Integration tests: Meta integrations RLS policies
 *
 * Verifies Row Level Security for:
 *   meta_business_managers   (token-bearing — REVOKE'd from browser)
 *   meta_business_managers_safe  (safe view, no token)
 *   meta_ad_accounts
 *   Token expiry state visibility
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  adminClient,
  generateTestEmail,
  createTestUser,
  createTestOrg,
  addMemberToOrg,
  insertTestMetaBM,
  cleanupTestOrgs,
} from "@setup/supabase-helpers";
import { VALID_PASSWORD, META_BUSINESS_ID } from "@fixtures";

const orgIds:    string[] = [];
const testEmails: string[] = [];

let ownerOrgId:   string;
let ownerClient:  any;
let analystUser:  any;
let outsiderUser: any;
let bmId:         string;
let adAccountId:  string;

beforeAll(async () => {
  const ownerEmail    = generateTestEmail("meta-rls-owner");
  const analystEmail  = generateTestEmail("meta-rls-analyst");
  const outsiderEmail = generateTestEmail("meta-rls-outsider");
  testEmails.push(ownerEmail, analystEmail, outsiderEmail);

  const owner    = await createTestUser(ownerEmail,    VALID_PASSWORD);
  analystUser    = await createTestUser(analystEmail,  VALID_PASSWORD);
  outsiderUser   = await createTestUser(outsiderEmail, VALID_PASSWORD);
  ownerClient    = owner.client;

  ownerOrgId = await createTestOrg(ownerClient, "Meta RLS Test Org");
  orgIds.push(ownerOrgId);
  await addMemberToOrg(ownerOrgId, analystUser.id, "analyst");

  // Insert test BM and ad account via admin
  bmId = await insertTestMetaBM({
    orgId:        ownerOrgId,
    businessId:   `bm-rls-${Date.now()}`,
    businessName: "RLS Test BM",
    status:       "active",
  });

  const { data: adAccount } = await adminClient()
    .from("meta_ad_accounts")
    .insert({
      organization_id:     ownerOrgId,
      business_manager_id: bmId,
      meta_account_id:     `rls_acct_${Date.now()}`,
      account_name:        "RLS Test Ad Account",
      currency:            "USD",
      is_active:           true,
    })
    .select("id")
    .single();
  adAccountId = adAccount!.id;
});

afterAll(async () => {
  await cleanupTestOrgs(orgIds);
  const admin = adminClient();
  for (const email of testEmails) {
    const { data } = await admin.auth.admin.listUsers();
    const user = data?.users.find((u: any) => u.email === email);
    if (user) await admin.auth.admin.deleteUser(user.id);
  }
});

describe("meta_business_managers_safe view", () => {
  it("owner can read BM via safe view", async () => {
    const { data, error } = await ownerClient
      .from("meta_business_managers_safe")
      .select("id, status")
      .eq("id", bmId)
      .single();
    expect(error).toBeNull();
    expect(data?.id).toBe(bmId);
  });

  it("safe view does NOT expose access_token", async () => {
    const { data } = await ownerClient
      .from("meta_business_managers_safe")
      .select("*")
      .eq("id", bmId)
      .single();
    expect(data).not.toHaveProperty("access_token");
  });

  it("analyst can read BM safe view", async () => {
    const { data } = await analystUser.client
      .from("meta_business_managers_safe")
      .select("id")
      .eq("id", bmId)
      .single();
    expect(data?.id).toBe(bmId);
  });

  it("outsider cannot read BMs of another org", async () => {
    const { data } = await outsiderUser.client
      .from("meta_business_managers_safe")
      .select("id")
      .eq("id", bmId);
    expect(data).toHaveLength(0);
  });

  it("expired BM has status = 'expired' visible in safe view", async () => {
    const expiredBmId = await insertTestMetaBM({
      orgId:      ownerOrgId,
      businessId: `expired-bm-${Date.now()}`,
      status:     "expired",
    });

    const { data } = await ownerClient
      .from("meta_business_managers_safe")
      .select("id, status")
      .eq("id", expiredBmId)
      .single();

    expect(data?.status).toBe("expired");
  });
});

describe("Direct meta_business_managers access (blocked by REVOKE)", () => {
  it("authenticated users cannot SELECT directly from meta_business_managers", async () => {
    const { error } = await analystUser.client
      .from("meta_business_managers")
      .select("id, access_token")
      .eq("id", bmId);
    expect(error).not.toBeNull();
  });

  it("outsider cannot SELECT from meta_business_managers", async () => {
    const { error } = await outsiderUser.client
      .from("meta_business_managers")
      .select("id")
      .eq("id", bmId);
    expect(error).not.toBeNull();
  });
});

describe("meta_ad_accounts RLS", () => {
  it("owner can read ad accounts via meta_ad_accounts_safe", async () => {
    const { data, error } = await ownerClient
      .from("meta_ad_accounts_safe")
      .select("id, account_name")
      .eq("id", adAccountId)
      .single();
    expect(error).toBeNull();
    expect(data?.id).toBe(adAccountId);
  });

  it("analyst can read ad accounts", async () => {
    const { data } = await analystUser.client
      .from("meta_ad_accounts_safe")
      .select("id")
      .eq("id", adAccountId)
      .single();
    expect(data?.id).toBe(adAccountId);
  });

  it("outsider cannot read ad accounts of another org", async () => {
    const { data } = await outsiderUser.client
      .from("meta_ad_accounts_safe")
      .select("id")
      .eq("id", adAccountId);
    expect(data).toHaveLength(0);
  });

  it("analyst cannot insert ad accounts (manage_integrations required)", async () => {
    const { error } = await analystUser.client
      .from("meta_ad_accounts")
      .insert({
        organization_id:     ownerOrgId,
        business_manager_id: bmId,
        meta_account_id:     "should-fail-insert",
        account_name:        "Unauthorized",
        currency:            "USD",
      });
    expect(error).not.toBeNull();
  });
});

describe("Token expiry state transitions (via admin)", () => {
  it("marking a BM as expired is reflected in the safe view", async () => {
    const bm2Id = await insertTestMetaBM({
      orgId:        ownerOrgId,
      businessId:   `token-expiry-bm-${Date.now()}`,
      businessName: "Soon To Expire BM",
      status:       "active",
    });

    // Simulate what meta-data.ts does when it gets error 190
    await adminClient()
      .from("meta_business_managers")
      .update({ status: "expired", updated_at: new Date().toISOString() })
      .eq("id", bm2Id);

    const { data } = await ownerClient
      .from("meta_business_managers_safe")
      .select("status")
      .eq("id", bm2Id)
      .single();

    expect(data?.status).toBe("expired");
  });

  it("reconnecting resets status back to active", async () => {
    const bm3Id = await insertTestMetaBM({
      orgId:        ownerOrgId,
      businessId:   `reconnect-bm-${Date.now()}`,
      businessName: "Reconnect BM",
      status:       "expired",
    });

    // Simulate what meta-oauth.ts does on re-auth
    await adminClient()
      .from("meta_business_managers")
      .update({
        status:           "active",
        access_token:     "new-fresh-token",
        token_expires_at: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
        last_verified_at: new Date().toISOString(),
        updated_at:       new Date().toISOString(),
      })
      .eq("id", bm3Id);

    const { data } = await ownerClient
      .from("meta_business_managers_safe")
      .select("status")
      .eq("id", bm3Id)
      .single();

    expect(data?.status).toBe("active");
  });
});
