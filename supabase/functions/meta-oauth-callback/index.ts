/**
 * Meta OAuth Callback — Supabase Edge Function
 * Deploy: supabase functions deploy meta-oauth-callback
 *
 * Receives the redirect from Facebook after the user grants permission,
 * exchanges the code for a long-lived token, discovers Business Managers,
 * upserts meta_business_managers + meta_ad_accounts rows, and closes the popup.
 *
 * This is Route 2 extracted from meta-oauth/index.ts so that Facebook's
 * redirect_uri (/functions/v1/meta-oauth-callback) resolves to a real function.
 *
 * Environment variables required:
 *   META_APP_ID
 *   META_APP_SECRET
 *   JWT_SECRET
 *   SUPABASE_URL          (set automatically)
 *   SUPABASE_SERVICE_ROLE_KEY (set automatically)
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const META_API = "https://graph.facebook.com/v21.0";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// ── HMAC-SHA256 state verification ─────────────────────────────────────────
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

// Closes the OAuth popup and signals the dashboard opener via postMessage
function popupCloser(event: string, data: Record<string, unknown> = {}): Response {
  const html = `<!DOCTYPE html><html><body><script>
    try { window.opener.postMessage(${JSON.stringify({ event, ...data })}, '*'); } catch(e){}
    window.close();
  <\/script><p>Closing…</p></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

serve(async (req: Request) => {
  const url = new URL(req.url);

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
    const accountsEndpoint = biz.id === "personal"
      ? `${META_API}/me/adaccounts?fields=id,name,currency,account_status,timezone_name&limit=100&access_token=${accessToken}`
      : `${META_API}/${biz.id}/owned_ad_accounts?fields=id,name,currency,account_status,timezone_name&limit=100&access_token=${accessToken}`;

    const accountsRes = await fetch(accountsEndpoint);
    const { data: accounts } = await accountsRes.json();

    const activeAccounts = ((accounts || []) as AdAccount[]).filter(
      (a) => a.account_status === 1
    );
    if (!activeAccounts.length) continue;

    // ── Upsert Business Manager row ──
    const { data: bmgr, error: bmgrErr } = await supabaseAdmin
      .from("meta_business_managers")
      .upsert(
        {
          organization_id:  orgId,
          business_id:      biz.id,
          business_name:    biz.name,
          access_token:     accessToken,
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

    // ── Upsert ad accounts linked to their Business Manager ──
    const accountRows = activeAccounts.map((a) => ({
      organization_id:     orgId,
      business_manager_id: bmgr.id,
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
