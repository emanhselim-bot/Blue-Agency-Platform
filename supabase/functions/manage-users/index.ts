/**
 * manage-users — Supabase Edge Function
 *
 * Owner-only endpoint for managing client accounts within an organization.
 * Uses the service role key so it can create/update/delete Supabase auth users.
 *
 * Actions (POST body):
 *   { action: "list" }
 *   { action: "create",       username, name, email, password }
 *   { action: "set_password", user_id, password }
 *   { action: "delete",       user_id }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

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

async function getCallerId(authHeader: string | null): Promise<string | null> {
  if (!authHeader) return null;
  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return null;
  return user.id;
}

async function isOwner(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", userId)
    .eq("role", "owner")
    .not("accepted_at", "is", null)
    .limit(1)
    .single();
  if (error || !data) return null;
  return data.organization_id;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const callerId = await getCallerId(req.headers.get("authorization"));
  if (!callerId) return json({ error: "Unauthorized" }, 401);

  const orgId = await isOwner(callerId);
  if (!orgId) return json({ error: "Forbidden: owner role required" }, 403);

  let body: Record<string, string>;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { action } = body;

  // ── LIST ──────────────────────────────────────────────────────────────────
  if (action === "list") {
    const { data: members, error } = await supabaseAdmin
      .from("organization_members")
      .select("user_id, role, accepted_at")
      .eq("organization_id", orgId)
      .not("accepted_at", "is", null);

    if (error) return json({ error: error.message }, 500);

    const users = await Promise.all(
      (members ?? []).map(async (m) => {
        const { data: { user } } = await supabaseAdmin.auth.admin.getUserById(m.user_id);
        return {
          user_id: m.user_id,
          email: user?.email ?? "",
          username: user?.user_metadata?.username ?? "",
          name: user?.user_metadata?.full_name ?? user?.user_metadata?.name ?? "",
          role: m.role,
          accepted_at: m.accepted_at,
          last_sign_in: user?.last_sign_in_at ?? null,
        };
      })
    );

    return json({ users });
  }

  // ── CREATE ────────────────────────────────────────────────────────────────
  if (action === "create") {
    const { username, name, email, password, role: rawRole } = body;
    if (!username) return json({ error: "username is required" }, 400);
    if (!email || !password) return json({ error: "email and password required" }, 400);
    if (password.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
    const VALID_ROLES = ["owner", "admin", "analyst", "viewer"];
    const role = VALID_ROLES.includes(rawRole) ? rawRole : "viewer";

    // Check username uniqueness across all auth users
    const { data: existing } = await supabaseAdmin.rpc("get_email_by_username", {
      p_username: username.toLowerCase().trim(),
    });
    if (existing) return json({ error: `Username "${username}" is already taken` }, 400);

    const { data: { user }, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        username: username.toLowerCase().trim(),
        full_name: name ?? "",
      },
    });

    if (createErr) return json({ error: createErr.message }, 400);
    if (!user) return json({ error: "User creation failed" }, 500);

    // Add to organization
    const { error: memberErr } = await supabaseAdmin
      .from("organization_members")
      .insert({
        organization_id: orgId,
        user_id: user.id,
        role,
        invited_by: callerId,
        accepted_at: new Date().toISOString(),
      });

    if (memberErr) {
      await supabaseAdmin.auth.admin.deleteUser(user.id);
      return json({ error: memberErr.message }, 500);
    }

    console.log("[manage-users] Created client:", username, email, "in org:", orgId);
    return json({
      user_id: user.id,
      email: user.email,
      username: user.user_metadata?.username ?? "",
      name: user.user_metadata?.full_name ?? "",
      role,
    });
  }

  // ── SET_PASSWORD ──────────────────────────────────────────────────────────
  if (action === "set_password") {
    const { user_id, password } = body;
    if (!user_id || !password) return json({ error: "user_id and password required" }, 400);
    if (password.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
    if (user_id === callerId) return json({ error: "Use account settings to change your own password" }, 400);

    const { data: membership } = await supabaseAdmin
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", orgId)
      .eq("user_id", user_id)
      .single();

    if (!membership) return json({ error: "User not in your organization" }, 403);

    const { error } = await supabaseAdmin.auth.admin.updateUserById(user_id, { password });
    if (error) return json({ error: error.message }, 400);

    console.log("[manage-users] Password updated for:", user_id);
    return json({ success: true });
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  if (action === "delete") {
    const { user_id } = body;
    if (!user_id) return json({ error: "user_id required" }, 400);
    if (user_id === callerId) return json({ error: "Cannot delete your own account" }, 400);

    const { data: membership } = await supabaseAdmin
      .from("organization_members")
      .select("user_id, role")
      .eq("organization_id", orgId)
      .eq("user_id", user_id)
      .single();

    if (!membership) return json({ error: "User not in your organization" }, 403);
    if (membership.role === "owner") return json({ error: "Cannot delete another owner" }, 403);

    await supabaseAdmin
      .from("organization_members")
      .delete()
      .eq("organization_id", orgId)
      .eq("user_id", user_id);

    const { error } = await supabaseAdmin.auth.admin.deleteUser(user_id);
    if (error) return json({ error: error.message }, 500);

    console.log("[manage-users] Deleted user:", user_id);
    return json({ success: true });
  }

  return json({ error: `Unknown action: ${action}` }, 400);
});
