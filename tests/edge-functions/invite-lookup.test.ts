/**
 * Edge Function tests: invite-lookup
 *
 * Run with Deno: deno test tests/edge-functions/invite-lookup.test.ts --allow-env --allow-net
 *
 * Tests invitation token lookup, expiry rejection, and already-accepted
 * token handling via HTTP requests to the local edge function.
 */

import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.211.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")             ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const LOOKUP_URL       = `${SUPABASE_URL}/functions/v1/invite-lookup`;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ── Setup helpers ─────────────────────────────────────────────────────────────

async function createOrgAndOwner(): Promise<{
  orgId: string;
  ownerId: string;
  cleanup: () => Promise<void>;
}> {
  const email = `invite-ef-owner-${Date.now()}@blue-agency-test.internal`;

  const { data: userCreate } = await admin.auth.admin.createUser({
    email,
    password:      "test-password-123",
    email_confirm: true,
  });
  const ownerId = userCreate.user!.id;

  const { data: org } = await admin
    .from("organizations")
    .insert({ name: "Invite Test Org", slug: `invite-ef-${Date.now()}` })
    .select("id")
    .single();
  const orgId = org!.id;

  await admin.from("organization_members").insert({
    organization_id: orgId,
    user_id:         ownerId,
    role:            "owner",
    accepted_at:     new Date().toISOString(),
  });

  return {
    orgId,
    ownerId,
    cleanup: async () => {
      await admin.from("organizations").delete().eq("id", orgId);
      await admin.auth.admin.deleteUser(ownerId);
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

Deno.test({
  name: "GET /invite-lookup without token returns 400",
  async fn() {
    const res = await fetch(LOOKUP_URL, { method: "GET" });
    assertEquals(res.status, 400);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "GET /invite-lookup with non-existent token returns 404",
  async fn() {
    const url = new URL(LOOKUP_URL);
    url.searchParams.set("token", "this-token-does-not-exist-anywhere");
    const res = await fetch(url.toString(), { method: "GET" });
    assertEquals(res.status, 404);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "valid token returns invitation metadata",
  async fn() {
    const { orgId, ownerId, cleanup } = await createOrgAndOwner();
    try {
      // Insert a valid invitation
      const inviteeEmail = `invitee-ef-${Date.now()}@blue-agency-test.internal`;
      const { data: inv } = await admin
        .from("invitations")
        .insert({
          organization_id: orgId,
          email:           inviteeEmail,
          role:            "analyst",
          invited_by:      ownerId,
        })
        .select("token")
        .single();

      assertExists(inv?.token);

      const url = new URL(LOOKUP_URL);
      url.searchParams.set("token", inv!.token);
      const res = await fetch(url.toString(), { method: "GET" });

      assertEquals(res.status, 200);
      const body = await res.json();

      assertEquals(body.email, inviteeEmail);
      assertEquals(body.role, "analyst");
      assertExists(body.organization_id ?? body.org_id);
    } finally {
      await cleanup();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "expired token returns 410 Gone",
  async fn() {
    const { orgId, ownerId, cleanup } = await createOrgAndOwner();
    try {
      const { data: inv } = await admin
        .from("invitations")
        .insert({
          organization_id: orgId,
          email:           `expired-ef-${Date.now()}@blue-agency-test.internal`,
          role:            "viewer",
          invited_by:      ownerId,
          expires_at:      new Date(Date.now() - 1000).toISOString(), // 1 second ago
        })
        .select("token")
        .single();

      const url = new URL(LOOKUP_URL);
      url.searchParams.set("token", inv!.token);
      const res = await fetch(url.toString(), { method: "GET" });

      // Expired → 410 Gone or 400 Bad Request
      assertEquals([400, 410].includes(res.status), true, `Expected 400/410, got ${res.status}`);
    } finally {
      await cleanup();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "already-accepted token returns 409 Conflict or 400",
  async fn() {
    const { orgId, ownerId, cleanup } = await createOrgAndOwner();
    try {
      const { data: inv } = await admin
        .from("invitations")
        .insert({
          organization_id: orgId,
          email:           `accepted-ef-${Date.now()}@blue-agency-test.internal`,
          role:            "analyst",
          invited_by:      ownerId,
        })
        .select("id, token")
        .single();

      // Mark as accepted
      await admin
        .from("invitations")
        .update({ accepted_at: new Date().toISOString() })
        .eq("id", inv!.id);

      const url = new URL(LOOKUP_URL);
      url.searchParams.set("token", inv!.token);
      const res = await fetch(url.toString(), { method: "GET" });

      // Already accepted → 409 or 400
      assertEquals([400, 409].includes(res.status), true, `Expected 400/409, got ${res.status}`);
    } finally {
      await cleanup();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "OPTIONS returns CORS headers",
  async fn() {
    const res = await fetch(LOOKUP_URL, { method: "OPTIONS" });
    const cors = res.headers.get("access-control-allow-origin");
    assertEquals(cors !== null, true, "Should have CORS header");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
