/**
 * Accept Invite — Supabase Edge Function
 * Deploy: supabase functions deploy accept-invite
 *
 * Validates an invitation token, confirms the authenticated user's email
 * matches the invitation, adds them to the organization, and marks the
 * invitation as accepted.
 *
 * Flow:
 *   1. User visits accept-invite.html?token=<hex>
 *   2. Page calls GET /invite-lookup?token=<hex> → preview (role, org_name)
 *   3. User signs in or signs up (Supabase Auth)
 *   4. Page calls POST /accept-invite { token } with Authorization header
 *   5. This function validates everything and returns { success, org_id, org_name, role }
 *   6. Page redirects to dashboard
 *
 * Environment variables (set automatically by Supabase):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const corsOrigin = Deno.env.get("APP_URL") || "*";

const cors = {
  "Access-Control-Allow-Origin": corsOrigin,
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // ── 1. Authenticate the caller ──────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Unauthorized" }, 401);

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(
    authHeader.replace("Bearer ", "")
  );
  if (authError || !user) return json({ error: "Unauthorized" }, 401);

  // ── 2. Parse and validate the token ────────────────────────────
  let body: { token?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const token = body.token ?? "";

  // Tokens are encode(gen_random_bytes(32), 'hex') = 64 lowercase hex chars
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return json({ error: "Invalid token format" }, 400);
  }

  // ── 3. Look up the invitation (service role bypasses RLS) ───────
  const { data: invitation, error: lookupError } = await supabaseAdmin
    .from("invitations")
    .select(`
      id,
      email,
      role,
      organization_id,
      expires_at,
      accepted_at,
      organizations ( name )
    `)
    .eq("token", token)
    .maybeSingle();

  if (lookupError) {
    console.error("accept-invite DB lookup error:", lookupError);
    return json({ error: "Internal error" }, 500);
  }

  // Return same 404 for "not found" and any future token format change
  if (!invitation) {
    return json({ error: "Invitation not found" }, 404);
  }

  if (invitation.accepted_at) {
    return json({ error: "Invitation already accepted" }, 410);
  }

  if (new Date(invitation.expires_at) < new Date()) {
    return json({ error: "Invitation expired" }, 410);
  }

  // ── 4. Verify the authenticated user's email matches ───────────
  // Case-insensitive comparison — email addresses are case-insensitive
  if (user.email?.toLowerCase() !== invitation.email?.toLowerCase()) {
    return json({ error: "Email mismatch — please sign in with the invited email address" }, 403);
  }

  const orgId   = invitation.organization_id as string;
  const orgName = (invitation as any).organizations?.name ?? "Unknown Organization";

  // ── 5. Upsert organization_members ─────────────────────────────
  // onConflict handles the case where the user was somehow already a member
  // (e.g., a previous failed accept attempt). We set accepted_at regardless.
  const { error: memberError } = await supabaseAdmin
    .from("organization_members")
    .upsert(
      {
        organization_id: orgId,
        user_id:         user.id,
        role:            invitation.role,
        accepted_at:     new Date().toISOString(),
      },
      { onConflict: "organization_id,user_id" }
    );

  if (memberError) {
    console.error("accept-invite member upsert error:", memberError);
    return json({ error: "Failed to add you to the organization" }, 500);
  }

  // ── 6. Mark invitation as accepted ─────────────────────────────
  const { error: inviteUpdateError } = await supabaseAdmin
    .from("invitations")
    .update({ accepted_at: new Date().toISOString() })
    .eq("id", invitation.id);

  if (inviteUpdateError) {
    // Non-fatal — the member row was already written. Log and continue.
    console.error("accept-invite invitation update error:", inviteUpdateError);
  }

  // ── 7. Write audit log entry ────────────────────────────────────
  await supabaseAdmin
    .from("audit_log")
    .insert({
      organization_id: orgId,
      user_id:         user.id,
      action:          "invitation_accepted",
      resource_type:   "invitation",
      resource_id:     invitation.id,
      metadata:        { role: invitation.role, email: user.email },
    })
    .then(({ error }) => {
      if (error) console.error("accept-invite audit log error:", error);
    });

  // ── 8. Return success ───────────────────────────────────────────
  return json({
    success:  true,
    org_id:   orgId,
    org_name: orgName,
    role:     invitation.role,
  });
});
