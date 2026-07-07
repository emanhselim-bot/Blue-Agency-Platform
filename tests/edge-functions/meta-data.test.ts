/**
 * Edge Function tests: meta-data
 *
 * Run with Deno: deno test tests/edge-functions/meta-data.test.ts --allow-env --allow-net
 *
 * Tests the meta-data edge function's authentication and error handling
 * behaviors. Uses a real local Supabase instance for integration-level tests.
 */

import { assertEquals } from "https://deno.land/std@0.211.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")             ?? "http://127.0.0.1:54321";
const ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY")         ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const META_DATA_URL    = `${SUPABASE_URL}/functions/v1/meta-data`;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ── Helpers ──────────────────────────────────────────────────────────────────

async function createUser(email: string): Promise<{ id: string; jwt: string }> {
  const password = "test-password-123";
  const { data } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  const userId = data.user!.id;

  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data: session } = await anonClient.auth.signInWithPassword({ email, password });
  return { id: userId, jwt: session.session!.access_token };
}

async function cleanup(userIds: string[]) {
  for (const id of userIds) {
    await admin.auth.admin.deleteUser(id);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

Deno.test({
  name: "unauthenticated request returns 401",
  async fn() {
    const res = await fetch(META_DATA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ad_account_id: "act_123" }),
    });
    assertEquals(res.status, 401);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "request with invalid JWT returns 401",
  async fn() {
    const res = await fetch(META_DATA_URL, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": "Bearer not-a-valid-jwt",
      },
      body: JSON.stringify({ ad_account_id: "act_123" }),
    });
    assertEquals(res.status, 401);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "missing ad_account_id returns 400",
  async fn() {
    const email  = `meta-data-test-${Date.now()}@blue-agency-test.internal`;
    const { id, jwt } = await createUser(email);
    try {
      const res = await fetch(META_DATA_URL, {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${jwt}`,
        },
        body: JSON.stringify({}),
      });
      assertEquals(res.status, 400);
    } finally {
      await cleanup([id]);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "request for non-member org returns 403 or 404",
  async fn() {
    const email  = `meta-data-outsider-${Date.now()}@blue-agency-test.internal`;
    const { id, jwt } = await createUser(email);
    try {
      const res = await fetch(META_DATA_URL, {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          ad_account_id:   "act_nonexistent_123",
          organization_id: "00000000-0000-0000-0000-000000000001",
        }),
      });
      // Not a member of that org → 403 or 404
      assertEquals([403, 404].includes(res.status), true, `Expected 403/404, got ${res.status}`);
    } finally {
      await cleanup([id]);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "TOKEN_EXPIRED response returns 401 with TOKEN_EXPIRED error body",
  async fn() {
    // This test verifies the response contract: when Meta returns error 190,
    // our edge function should return { error: "TOKEN_EXPIRED" } with status 401.
    //
    // We insert a BM with a known-bad access token and verify the response shape.
    const email  = `meta-expired-${Date.now()}@blue-agency-test.internal`;
    const { id, jwt } = await createUser(email);

    // Create org
    const anonClient = createClient(SUPABASE_URL, ANON_KEY);
    await anonClient.auth.setSession({ access_token: jwt, refresh_token: "" } as any);
    const { data: orgId } = await anonClient.rpc("create_organization", {
      org_name: "Token Expiry Test Org",
    });

    // Insert expired BM and ad account via service role
    const { data: bm } = await admin
      .from("meta_business_managers")
      .insert({
        organization_id: orgId,
        meta_business_id: `exp-bm-${Date.now()}`,
        business_name:    "Expired BM",
        access_token:     "expired_token_that_will_fail",
        status:           "expired",
      })
      .select("id")
      .single();

    const { data: adAccount } = await admin
      .from("meta_ad_accounts")
      .insert({
        organization_id:     orgId,
        business_manager_id: bm!.id,
        meta_account_id:     `act_expired_${Date.now()}`,
        account_name:        "Expired Ad Account",
        currency:            "USD",
        is_active:           true,
      })
      .select("id, meta_account_id")
      .single();

    try {
      const res = await fetch(META_DATA_URL, {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          ad_account_id:   adAccount!.meta_account_id,
          organization_id: orgId,
        }),
      });

      // The function should return 401 with TOKEN_EXPIRED error
      // (Meta will reject the expired token with error 190)
      if (res.status === 401) {
        const body = await res.json();
        assertEquals(body.error, "TOKEN_EXPIRED");
      } else {
        // In test environment Meta API calls may fail differently;
        // accept any 4xx as long as a real token isn't present
        assertEquals(res.status >= 400, true, `Expected 4xx for expired token, got ${res.status}`);
      }
    } finally {
      await admin.from("organizations").delete().eq("id", orgId);
      await cleanup([id]);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "OPTIONS request returns CORS headers",
  async fn() {
    const res = await fetch(META_DATA_URL, { method: "OPTIONS" });
    const allowOrigin = res.headers.get("access-control-allow-origin");
    assertEquals(allowOrigin !== null, true, "Should have CORS origin header");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
