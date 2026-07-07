/**
 * Meta OAuth — Supabase Edge Function
 * Deploy: supabase functions deploy meta-oauth
 *         supabase functions deploy meta-oauth-callback
 *
 * Flow:
 *  1. Dashboard calls GET /meta-oauth?org_id=xxx  (with user JWT)
 *  2. This function redirects to Facebook Login dialog
 *  3. Facebook redirects to /meta-oauth-callback?code=...&state=...
 *  4. Callback exchanges code for long-lived token (60 days)
 *  5. Fetches user's Business Managers and discovers all ad accounts
 *  6. Upserts ONE meta_business_managers row per Business Manager
 *  7. Upserts ad accounts linked to their Business Manager (not to the token directly)
 *  8. Returns HTML that posts a message to the opener and self-closes
 *
 * Why meta_business_managers?
 *   The access token belongs to the Business Manager / user connection,
 *   not to individual ad accounts. Storing it once on the Business Manager
 *   row means: (a) token rotation touches one row, not N ad-account rows;
 *   (b) audit trail shows which Business Manager was connected by whom;
 *   (c) the token is never exposed to ad-account level queries.
 *
 * Environment variables required:
 *   META_APP_ID         — from Meta Business App → App ID
 *   META_APP_SECRET     — from Meta Business App → App Secret
 *   JWT_SECRET          — same value used in shopify-oauth.ts
 *   SUPABASE_URL        — set automatically
 *   SUPABASE_SERVICE_ROLE_KEY — set automatically
 *
 * Required Meta app scopes: ads_read, ads_management, business_management
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const META_API = "https://graph.facebook.com/v21.0";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// ── HMAC-SHA256 state signing (no external JWT library needed) ──────────────
async function signState(payload: object): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(Deno.env.get("JWT_SECRET")!),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const data = JSON.stringify({ ...payload, exp: Date.now() + 600_000 }); // 10 min expiry
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const sigHex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return btoa(data) + "." + sigHex;
}

async function verifyState(state: string): Promise<Record<string, unknown> | null> {
  const [b64, sigHex] = state.split(".");
  if (!b64 || !sigHex) return null;
  const data = atob(b64);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(Deno.env.get("JWT_SECRET")!),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const sigBytes = new Uint8Array(sigHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(data));
  if (!valid) return null;
  const payload = JSON.parse(data);
  if (payload.exp < Date.now()) return null; // expired
  return payload;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
};

// Closes the OAuth popup and signals the dashboard opener via postMessage
function popupCloser(event: string, data: Record<string, unknown> = {}): Response {
  const html = `<!DOCTYPE html><html><body><script>
    try { window.opener.postMessage(${JSON.stringify({ event, ...data })}, '*'); } catch(e){}
    window.close();
  <\/script><p>Closing…</p></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const url = new URL(req.url);

  // ═══════════════════════════════════════════════════════════════
  // ROUTE 1: Initiate Meta OAuth
  // GET /functions/v1/meta-oauth?org_id=...
  // Called via window.open() from the dashboard (popup context)
  // ═══════════════════════════════════════════════════════════════
  if (!url.pathname.includes("callback")) {
    const orgId     = url.searchParams.get("org_id");
    const userToken = url.searchParams.get("t"); // short-lived Supabase JWT passed via URL
    if (!orgId || !userToken) return new Response("Missing org_id or t", { status: 400 });

    // Verify user is authenticated
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(userToken);
    if (error || !user) return new Response("Unauthorized", { status: 401 });

    // Verify user has permission to connect integrations in this org
    const { data: member } = await supabaseAdmin
      .from("organization_members")
      .select("role")
      .eq("organization_id", orgId)
      .eq("user_id", user.id)
      .not("accepted_at", "is", null)
      .single();

    if (!member || !["owner", "admin"].includes(member.role)) {
      return new Response("Forbidden: must be org admin or owner", { status: 403 });
    }

    // Sign state param (prevents CSRF; expires in 10 minutes)
    const state = await signState({ org_id: orgId, user_id: user.id });

    const callbackUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/meta-oauth-callback`;
    const fbUrl =
      `https://www.facebook.com/dialog/oauth?` +
      new URLSearchParams({
        client_id:     Deno.env.get("META_APP_ID")!,
        redirect_uri:  callbackUrl,
        scope:         "ads_read,ads_management,business_management",
        response_type: "code",
        state,
      }).toString();

    return Response.redirect(fbUrl, 302);
  }

  // ═══════════════════════════════════════════════════════════════
  // ROUTE 2: Meta OAuth Callback
  // GET /functions/v1/meta-oauth-callback?code=...&state=...
  // ═══════════════════════════════════════════════════════════════
  const code    = url.searchParams.get("code");
  const state   = url.searchParams.get("state");
  const fbError = url.searchParams.get("error_description");

  if (fbError) return popupCloser("meta_oauth_error", { message: fbError });
  if (!code || !state) return popupCloser("meta_oauth_error", { message: "Missing params" });

  const statePayload = await verifyState(state);
  if (!statePayload) return popupCloser("meta_oauth_error", { message: "Invalid or expired state" });

  const orgId      = statePayload.org_id  as string;
  const userId     = statePayload.user_id as string;
  const callbackUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/meta-oauth-callback`;

  // ── 1. Exchange code for short-lived token ──────────────────────
  const shortTokenRes = await fetch(
    `${META_API}/oauth/access_token?` +
      new URLSearchParams({
        client_id:     Deno.env.get("META_APP_ID")!,
        client_secret: Deno.env.get("META_APP_SECRET")!,
        redirect_uri:  callbackUrl,
        code,
      }).toString()
  );
  const { access_token: shortToken, error: tokenErr } = await shortTokenRes.json();
  if (tokenErr || !shortToken) {
    return popupCloser("meta_oauth_error", { message: "Token exchange failed" });
  }

  // ── 2. Exchange for long-lived token (60 days) ──────────────────
  const longTokenRes = await fetch(
    `${META_API}/oauth/access_token?` +
      new URLSearchParams({
        grant_type:        "fb_exchange_token",
        client_id:         Deno.env.get("META_APP_ID")!,
        client_secret:     Deno.env.get("META_APP_SECRET")!,
        fb_exchange_token: shortToken,
      }).toString()
  );
  const { access_token: longToken, expires_in } = await longTokenRes.json();
  const accessToken    = longToken || shortToken;
  const tokenExpiresAt = expires_in
    ? new Date(Date.now() + expires_in * 1000).toISOString()
    : null;

  // ── 3. Discover Business Managers on this token ─────────────────
  const bizRes = await fetch(
    `${META_API}/me/businesses?fields=id,name&limit=50&access_token=${accessToken}`
  );
  const { data: businesses } = await bizRes.json();

  type BizManager = { id: string; name: string };
  type AdAccount  = {
    id: string; name: string; currency: string;
    account_status: number; timezone_name: string;
  };

  // If no Business Managers found, fall back to user's personal ad accounts
  const bizList: BizManager[] = businesses?.length
    ? businesses
    : [{ id: "personal", name: "Personal Ad Accounts" }];

  let totalAccountsConnected = 0;
  const businessManagerIds: string[] = [];

  // ── 4. Process each Business Manager ───────────────────────────
  for (const biz of bizList) {
    // Fetch ad accounts for this Business Manager
    const accountsEndpoint = biz.id === "personal"
      ? `${META_API}/me/adaccounts?fields=id,name,currency,account_status,timezone_name&limit=100&access_token=${accessToken}`
      : `${META_API}/${biz.id}/owned_ad_accounts?fields=id,name,currency,account_status,timezone_name&limit=100&access_token=${accessToken}`;

    const accountsRes = await fetch(accountsEndpoint);
    const { data: accounts } = await accountsRes.json();

    const activeAccounts = ((accounts || []) as AdAccount[]).filter(
      (a) => a.account_status === 1
    );
    if (!activeAccounts.length) continue;

    // ── Upsert Business Manager row (token lives here, not on accounts) ──
    const { data: bmgr, error: bmgrErr } = await supabaseAdmin
      .from("meta_business_managers")
      .upsert(
        {
          organization_id:  orgId,
          business_id:      biz.id,
          business_name:    biz.name,
          access_token:     accessToken,          // one token per Business Manager
          token_expires_at: tokenExpiresAt,
          scopes:           ["ads_read", "ads_management", "business_management"],
          connected_by:     userId,
          status:           "active",
          last_verified_at: new Date().toISOString(),
          connected_at:     new Date().toISOString(),
        },
        { onConflict: "organization_id,business_id" }
      )
      .select("id")
      .single();

    if (bmgrErr || !bmgr) {
      console.error("Failed to upsert business manager:", bmgrErr);
      continue;
    }

    businessManagerIds.push(bmgr.id);

    // ── Upsert ad accounts, each linked to their Business Manager ──
    const accountRows = activeAccounts.map((a) => ({
      organization_id:     orgId,
      business_manager_id: bmgr.id,            // FK → meta_business_managers
      meta_account_id:     a.id.replace("act_", ""),
      account_name:        a.name,
      currency:            a.currency,
      timezone:            a.timezone_name || null,
      account_status:      a.account_status,
      is_active:           true,
      connected_at:        new Date().toISOString(),
    }));

    const { error: accErr } = await supabaseAdmin
      .from("meta_ad_accounts")
      .upsert(accountRows, { onConflict: "organization_id,meta_account_id" });

    if (accErr) {
      console.error("Failed to upsert ad accounts:", accErr);
    } else {
      totalAccountsConnected += accountRows.length;
    }
  }

  if (totalAccountsConnected === 0) {
    return popupCloser("meta_oauth_error", {
      message: "No active ad accounts found on this Meta account",
    });
  }

  // ── 5. Write to audit log ────────────────────────────────────────
  await supabaseAdmin.from("audit_log").insert({
    organization_id: orgId,
    user_id:         userId,
    action:          "meta.business_manager.connected",
    resource_type:   "meta_business_manager",
    metadata: {
      business_manager_ids: businessManagerIds,
      accounts_connected:   totalAccountsConnected,
    },
  });

  // ── 6. Close popup and signal dashboard to reload ────────────────
  return popupCloser("meta_oauth_complete", {
    accounts_connected: totalAccountsConnected,
    org_id:             orgId,
  });
});
