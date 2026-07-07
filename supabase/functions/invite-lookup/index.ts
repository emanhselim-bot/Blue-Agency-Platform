/**
 * Invite Lookup — Supabase Edge Function
 * Deploy: supabase functions deploy invite-lookup
 *
 * Validates an invitation token without exposing the invitations table
 * to unauthenticated or cross-org queries. Replaces the removed
 * "invitations: readable by token" RLS policy (which used USING (true)
 * and allowed any authenticated user to enumerate all invitations).
 *
 * Flow:
 *   Dashboard/email link  →  GET /invite-lookup?token=<hex>
 *   Edge Function         →  service-role lookup (bypasses RLS)
 *   Response              →  {valid, role, org_name, expires_at}
 *                            (email and org_id are never returned)
 *
 * For the acceptance step (setting accepted_at), call this function
 * first to validate, then sign in / sign up normally — Supabase Auth
 * triggers handle_new_user(), and the accept-invite flow in the
 * dashboard sets accepted_at via the organization_members update policy.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("APP_URL") || "*",
  "Access-Control-Allow-Headers": "content-type, x-client-info, apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";

  // Reject obviously bad tokens before hitting the DB.
  // Tokens are encode(gen_random_bytes(32), 'hex') = 64 hex chars.
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return json({ error: "Invalid token format" }, 400);
  }

  // Service role bypasses RLS — we look up the token without exposing
  // any other rows to the caller.
  const { data: invitation, error } = await supabaseAdmin
    .from("invitations")
    .select(`
      id,
      role,
      expires_at,
      accepted_at,
      organizations ( name )
    `)
    .eq("token", token)
    .maybeSingle();

  if (error) {
    console.error("invite-lookup DB error:", error);
    return json({ error: "Internal error" }, 500);
  }

  // Return the same 404 for "not found", "wrong token", and any future
  // token-format change — avoids oracle attacks.
  if (!invitation) {
    return json({ error: "Invitation not found" }, 404);
  }

  if (invitation.accepted_at) {
    return json({ error: "Invitation already accepted" }, 410);
  }

  if (new Date(invitation.expires_at) < new Date()) {
    return json({ error: "Invitation expired" }, 410);
  }

  // Return only what the UI needs to render the accept-invite page.
  // Deliberately omit: email, org_id, invited_by, token.
  return json({
    valid: true,
    role: invitation.role,
    org_name: (invitation as any).organizations?.name ?? "Unknown Organization",
    expires_at: invitation.expires_at,
  });
});
