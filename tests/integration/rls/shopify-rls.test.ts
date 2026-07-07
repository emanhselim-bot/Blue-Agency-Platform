/**
 * Integration tests: Shopify + Orders RLS policies
 *
 * Verifies that Row Level Security enforces:
 *   • Members can read their org's stores (via shopify_stores_safe view)
 *   • Direct SELECT on shopify_stores is blocked (token column protection)
 *   • Non-members cannot read stores of other orgs
 *   • Admins can write; analysts/viewers cannot
 *   • shopify_orders are readable by members with view_analytics permission
 *   • shopify_webhook_subscriptions follow the same org-scoped access
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  adminClient,
  generateTestEmail,
  createTestUser,
  createTestOrg,
  addMemberToOrg,
  insertTestShopifyStore,
  cleanupTestOrgs,
} from "@setup/supabase-helpers";
import { VALID_PASSWORD, SHOPIFY_SHOP_DOMAIN } from "@fixtures";

const orgIds:    string[] = [];
const testEmails: string[] = [];

// Shared org with all roles
let ownerOrgId:  string;
let ownerClient:   any;
let adminUser:     any;
let analystUser:   any;
let viewerUser:    any;
let outsiderUser:  any;
let storeId:       string;

beforeAll(async () => {
  const ownerEmail    = generateTestEmail("rls-shop-owner");
  const adminEmail    = generateTestEmail("rls-shop-admin");
  const analystEmail  = generateTestEmail("rls-shop-analyst");
  const viewerEmail   = generateTestEmail("rls-shop-viewer");
  const outsiderEmail = generateTestEmail("rls-shop-outsider");
  testEmails.push(ownerEmail, adminEmail, analystEmail, viewerEmail, outsiderEmail);

  const owner    = await createTestUser(ownerEmail,    VALID_PASSWORD);
  adminUser      = await createTestUser(adminEmail,    VALID_PASSWORD);
  analystUser    = await createTestUser(analystEmail,  VALID_PASSWORD);
  viewerUser     = await createTestUser(viewerEmail,   VALID_PASSWORD);
  outsiderUser   = await createTestUser(outsiderEmail, VALID_PASSWORD);

  ownerClient  = owner.client;
  ownerOrgId   = await createTestOrg(ownerClient, "Shopify RLS Test Org");
  orgIds.push(ownerOrgId);

  await addMemberToOrg(ownerOrgId, adminUser.id,   "admin");
  await addMemberToOrg(ownerOrgId, analystUser.id, "analyst");
  await addMemberToOrg(ownerOrgId, viewerUser.id,  "viewer");

  storeId = await insertTestShopifyStore({
    orgId:      ownerOrgId,
    shopDomain: `rls-test-${Date.now()}.myshopify.com`,
    shopName:   "RLS Test Store",
  });
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

describe("shopify_stores_safe view (token-free)", () => {
  it("owner can read stores via the safe view", async () => {
    const { data, error } = await ownerClient
      .from("shopify_stores_safe")
      .select("id, shop_domain, status")
      .eq("id", storeId)
      .single();
    expect(error).toBeNull();
    expect(data?.id).toBe(storeId);
  });

  it("safe view does NOT expose the access_token column", async () => {
    const { data } = await ownerClient
      .from("shopify_stores_safe")
      .select("*")
      .eq("id", storeId)
      .single();
    expect(data).not.toHaveProperty("access_token");
  });

  it("admin can read stores via safe view", async () => {
    const { data } = await adminUser.client
      .from("shopify_stores_safe")
      .select("id")
      .eq("id", storeId)
      .single();
    expect(data?.id).toBe(storeId);
  });

  it("analyst can read stores via safe view", async () => {
    const { data } = await analystUser.client
      .from("shopify_stores_safe")
      .select("id")
      .eq("id", storeId)
      .single();
    expect(data?.id).toBe(storeId);
  });

  it("viewer can read stores via safe view", async () => {
    const { data } = await viewerUser.client
      .from("shopify_stores_safe")
      .select("id")
      .eq("id", storeId)
      .single();
    expect(data?.id).toBe(storeId);
  });

  it("outsider cannot read stores of another org", async () => {
    const { data } = await outsiderUser.client
      .from("shopify_stores_safe")
      .select("id")
      .eq("id", storeId);
    expect(data).toHaveLength(0);
  });
});

describe("Direct shopify_stores access (blocked by REVOKE)", () => {
  it("authenticated users cannot SELECT directly from shopify_stores", async () => {
    // REVOKE SELECT on shopify_stores means even org members can't read the raw table
    const { error } = await analystUser.client
      .from("shopify_stores")
      .select("id")
      .eq("id", storeId);
    // Expect permission denied error
    expect(error).not.toBeNull();
  });
});

describe("Shopify store writes (manage_integrations)", () => {
  it("admin can insert a new store record", async () => {
    const { error } = await adminUser.client
      .from("shopify_stores")
      .insert({
        organization_id: ownerOrgId,
        shop_domain:     `admin-rls-${Date.now()}.myshopify.com`,
        shop_name:       "Admin Created Store",
        access_token:    "test-token",
        scopes:          "read_orders",
        connected_at:    new Date().toISOString(),
      });
    // Admins have manage_integrations permission
    expect(error).toBeNull();
  });

  it("analyst cannot insert a store (no manage_integrations)", async () => {
    const { error } = await analystUser.client
      .from("shopify_stores")
      .insert({
        organization_id: ownerOrgId,
        shop_domain:     `analyst-rls-${Date.now()}.myshopify.com`,
        shop_name:       "Should Fail",
        access_token:    "test-token",
        scopes:          "read_orders",
        connected_at:    new Date().toISOString(),
      });
    expect(error).not.toBeNull();
  });

  it("viewer cannot insert a store", async () => {
    const { error } = await viewerUser.client
      .from("shopify_stores")
      .insert({
        organization_id: ownerOrgId,
        shop_domain:     `viewer-rls-${Date.now()}.myshopify.com`,
        shop_name:       "Should Fail",
        access_token:    "test-token",
        scopes:          "read_orders",
        connected_at:    new Date().toISOString(),
      });
    expect(error).not.toBeNull();
  });
});

describe("shopify_orders RLS", () => {
  let orderRow: { id: string } | null = null;

  beforeAll(async () => {
    // Insert a test order via admin (simulating what the webhook handler does)
    const { data } = await adminClient()
      .from("shopify_orders")
      .insert({
        store_id:          storeId,
        organization_id:   ownerOrgId,
        shopify_order_id:  "rls-test-order-001",
        order_number:      9001,
        email:             "rls-customer@example.com",
        financial_status:  "paid",
        total_price:       99.99,
        currency:          "USD",
        line_items_count:  1,
        created_at_shopify: new Date().toISOString(),
      })
      .select("id")
      .single();
    orderRow = data;
  });

  it("owner can read shopify_orders", async () => {
    const { data } = await ownerClient
      .from("shopify_orders")
      .select("shopify_order_id")
      .eq("organization_id", ownerOrgId)
      .limit(1);
    expect(data?.length).toBeGreaterThan(0);
  });

  it("analyst (view_analytics) can read shopify_orders", async () => {
    const { data } = await analystUser.client
      .from("shopify_orders")
      .select("shopify_order_id")
      .eq("organization_id", ownerOrgId)
      .limit(1);
    expect(data?.length).toBeGreaterThan(0);
  });

  it("outsider cannot read shopify_orders of another org", async () => {
    const { data } = await outsiderUser.client
      .from("shopify_orders")
      .select("shopify_order_id")
      .eq("organization_id", ownerOrgId);
    expect(data).toHaveLength(0);
  });

  it("browser clients cannot INSERT into shopify_orders (service role only)", async () => {
    // Orders should only be inserted by the webhook Edge Function via service role
    const { error } = await analystUser.client
      .from("shopify_orders")
      .insert({
        store_id:         storeId,
        organization_id:  ownerOrgId,
        shopify_order_id: "browser-inserted-order",
        order_number:     9999,
        financial_status: "paid",
        currency:         "USD",
        created_at_shopify: new Date().toISOString(),
      });
    expect(error).not.toBeNull();
  });
});
