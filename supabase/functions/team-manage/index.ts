/**
 * Team Manage — Supabase Edge Function
 * Deploy: supabase functions deploy team-manage
 *
 * Owner-only endpoint for managing team members:
 *   action: 'list'          → list all members + pending invites
 *   action: 'invite'        → create invite token, return invite URL
 *   action: 'update_access' → set allowed_account_ids / allowed_agency_ids
 *   action: 'remove'        → remove a member from the org
 *   action: 'revoke_invite' → delete a pending invitation
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const APP_URL = Deno.env.get("APP_URL") || "https://web-production-b4926.up.railway.app";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Verify caller is an owner of the given org
async function verifyOwner(userId: string, orgId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("organization_members")
    .select("role")
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .not("accepted_at", "is", null)
    .single();
  return data?.role === "owner";
}

// Generate a secure 64-char hex token
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // Auth
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Unauthorized" }, 401);

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(
    authHeader.replace("Bearer ", "")
  );
  if (authError || !user) return json({ error: "Unauthorized" }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON body" }, 400); }

  const { action, org_id } = body as { action: string; org_id: string };
  if (!action) return json({ error: "action is required" }, 400);
  if (!org_id)  return json({ error: "org_id is required" }, 400);

  // ── LIST ──────────────────────────────────────────────────────────────────
  if (action === "list") {
    if (!(await verifyOwner(user.id, org_id))) {
      return json({ error: "Owner access required" }, 403);
    }

    // Active members
    const { data: members, error: mErr } = await supabaseAdmin
      .from("organization_members")
      .select(`
        id, user_id, role, accepted_at, allowed_account_ids, allowed_agency_ids,
        profiles!organization_members_user_id_fkey ( email, full_name )
      `)
      .eq("organization_id", org_id)
      .not("accepted_at", "is", null)
      .order("accepted_at", { ascending: false });

    if (mErr) return json({ error: mErr.message }, 500);

    // Pending invitations
    const { data: pending, error: pErr } = await supabaseAdmin
      .from("invitations")
      .select("id, email, role, created_at, expires_at, token")
      .eq("organization_id", org_id)
      .is("accepted_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false });

    if (pErr) return json({ error: pErr.message }, 500);

    const memberList = (members || []).map((m: any) => ({
      id:                  m.id,
      user_id:             m.user_id,
      email:               m.profiles?.email ?? "—",
      full_name:           m.profiles?.full_name ?? null,
      role:                m.role,
      accepted_at:         m.accepted_at,
      allowed_account_ids: m.allowed_account_ids,
      allowed_agency_ids:  m.allowed_agency_ids,
      is_pending:          false,
    }));

    const pendingList = (pending || []).map((i: any) => ({
      id:         i.id,
      user_id:    null,
      email:      i.email,
      full_name:  null,
      role:       i.role,
      accepted_at: null,
      allowed_account_ids: null,
      allowed_agency_ids:  null,
      is_pending: true,
      invite_url: `${APP_URL}/accept-invite.html?token=${i.token}`,
    }));

    return json({ members: [...memberList, ...pendingList] });
  }

  // ── INVITE ────────────────────────────────────────────────────────────────
  if (action === "invite") {
    if (!(await verifyOwner(user.id, org_id))) {
      return json({ error: "Owner access required" }, 403);
    }

    const { email, role = "analyst" } = body as { email: string; role?: string };
    if (!email) return json({ error: "email is required" }, 400);

    const normalizedEmail = email.trim().toLowerCase();

    // Check if already a member
    const { data: existingProfile } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("email", normalizedEmail)
      .single();

    if (existingProfile) {
      const { data: existingMember } = await supabaseAdmin
        .from("organization_members")
        .select("id")
        .eq("organization_id", org_id)
        .eq("user_id", existingProfile.id)
        .single();

      if (existingMember) {
        return json({ error: "User is already a member of this organization" }, 409);
      }
    }

    // Check for existing pending invite
    const { data: existingInvite } = await supabaseAdmin
      .from("invitations")
      .select("id, token")
      .eq("organization_id", org_id)
      .eq("email", normalizedEmail)
      .is("accepted_at", null)
      .single();

    if (existingInvite) {
      // Return existing invite link
      return json({
        invite_url: `${APP_URL}/accept-invite.html?token=${existingInvite.token}`,
        reused: true,
      });
    }

    // Generate new invite token
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

    const { error: insertErr } = await supabaseAdmin
      .from("invitations")
      .insert({
        organization_id: org_id,
        email:           normalizedEmail,
        role,
        token,
        expires_at:      expiresAt,
        invited_by:      user.id,
      });

    if (insertErr) return json({ error: insertErr.message }, 500);

    return json({
      invite_url: `${APP_URL}/accept-invite.html?token=${token}`,
      reused: false,
    });
  }

  // ── UPDATE ACCESS ─────────────────────────────────────────────────────────
  if (action === "update_access") {
    if (!(await verifyOwner(user.id, org_id))) {
      return json({ error: "Owner access required" }, 403);
    }

    const { member_id, allowed_account_ids, allowed_agency_ids } = body as {
      member_id: string;
      allowed_account_ids: string[] | null;
      allowed_agency_ids: string[] | null;
    };
    if (!member_id) return json({ error: "member_id is required" }, 400);

    // Verify the member belongs to this org and is not an owner
    const { data: member } = await supabaseAdmin
      .from("organization_members")
      .select("role, organization_id")
      .eq("id", member_id)
      .single();

    if (!member) return json({ error: "Member not found" }, 404);
    if (member.organization_id !== org_id) return json({ error: "Forbidden" }, 403);
    if (member.role === "owner") return json({ error: "Cannot restrict owner access" }, 400);

    const { error: updateErr } = await supabaseAdmin
      .from("organization_members")
      .update({
        allowed_account_ids: allowed_account_ids ?? null,
        allowed_agency_ids:  allowed_agency_ids  ?? null,
      })
      .eq("id", member_id);

    if (updateErr) return json({ error: updateErr.message }, 500);
    return json({ success: true });
  }

  // ── REMOVE MEMBER ─────────────────────────────────────────────────────────
  if (action === "remove") {
    if (!(await verifyOwner(user.id, org_id))) {
      return json({ error: "Owner access required" }, 403);
    }

    const { member_id } = body as { member_id: string };
    if (!member_id) return json({ error: "member_id is required" }, 400);

    // Check the member is in this org and is not an owner
    const { data: member } = await supabaseAdmin
      .from("organization_members")
      .select("role, organization_id, user_id")
      .eq("id", member_id)
      .single();

    if (!member) return json({ error: "Member not found" }, 404);
    if (member.organization_id !== org_id) return json({ error: "Forbidden" }, 403);
    if (member.role === "owner") return json({ error: "Cannot remove the owner" }, 400);
    if (member.user_id === user.id) return json({ error: "Cannot remove yourself" }, 400);

    const { error: delErr } = await supabaseAdmin
      .from("organization_members")
      .delete()
      .eq("id", member_id);

    if (delErr) return json({ error: delErr.message }, 500);
    return json({ success: true });
  }

  // ── REVOKE INVITE ──────────────────────────────────────────────────────────
  if (action === "revoke_invite") {
    if (!(await verifyOwner(user.id, org_id))) {
      return json({ error: "Owner access required" }, 403);
    }

    const { invite_id } = body as { invite_id: string };
    if (!invite_id) return json({ error: "invite_id is required" }, 400);

    const { error: delErr } = await supabaseAdmin
      .from("invitations")
      .delete()
      .eq("id", invite_id)
      .eq("organization_id", org_id);

    if (delErr) return json({ error: delErr.message }, 500);
    return json({ success: true });
  }

  return json({ error: `Unknown action: ${action}` }, 400);
});
