/**
 * Meta Token Refresh — Supabase Edge Function
 * Deploy: supabase functions deploy meta-token-refresh
 *
 * Silently extends Meta long-lived tokens before their 60-day expiry.
 * Must be called BEFORE a token expires — Meta rejects refresh attempts
 * on already-expired tokens, so this must run on a regular schedule.
 *
 * What it does:
 *   1. Finds all active business managers whose token expires within 7 days,
 *      or whose token_expires_at is NULL (connected before expiry tracking).
 *   2. For each, calls Meta's fb_exchange_token endpoint to get a fresh
 *      long-lived token (another ~60 days).
 *   3. Updates access_token, token_expires_at, and last_verified_at in DB.
 *   4. If a refresh fails (token already expired or revoked), marks the
 *      business manager status = 'expired' so the dashboard shows the
 *      "Reconnect Meta" prompt to the user.
 *
 * Authentication:
 *   Requires the Supabase service role key as the Bearer token.
 *   Never called by the browser — only by cron or an admin script.
 *
 * Schedule setup (run once in Supabase SQL editor):
 *   -- Requires pg_cron and pg_net extensions (enabled in Supabase dashboard)
 *   select cron.schedule(
 *     'meta-token-refresh-daily',
 *     '0 2 * * *',
 *     $$
 *       select net.http_post(
 *         url     := current_setting('app.supabase_url') || '/functions/v1/meta-token-refresh',
 *         headers := jsonb_build_object(
 *           'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
 *           'Content-Type',  'application/json'
 *         ),
 *         body    := '{}'::jsonb
 *       );
 *     $$
 *   );
 *
 *   -- Set the settings that the cron job reads:
 *   alter database postgres set app.supabase_url = 'https://YOUR_PROJECT.supabase.co';
 *   alter database postgres set app.service_role_key = 'YOUR_SERVICE_ROLE_KEY';
 *
 * Manual trigger (from a terminal, for testing):
 *   curl -X POST https://YOUR_PROJECT.supabase.co/functions/v1/meta-token-refresh \
 *     -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
 *     -H "Content-Type: application/json" \
 *     -d '{}'
 *
 * Environment variables required (set via supabase secrets set):
 *   META_APP_ID           — Facebook App ID
 *   META_APP_SECRET       — Facebook App Secret
 *   SUPABASE_URL          — set automatically by Supabase
 *   SUPABASE_SERVICE_ROLE_KEY — set automatically by Supabase
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const META_API = "https://graph.facebook.com/v21.0";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type RefreshResult = {
  id:            string;
  business_name: string | null;
  business_id:   string;
  outcome:       "refreshed" | "failed" | "db_error" | "error";
  new_expires_at?: string;
  error?:         string;
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  // ── Auth: service role only ───────────────────────────────────────────────
  // This function reads and rotates access tokens — it must never be callable
  // by a browser client. The service role key acts as the shared secret.
  const authHeader    = req.headers.get("Authorization") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (authHeader !== `Bearer ${serviceRoleKey}`) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  // ── Find tokens that need refreshing ─────────────────────────────────────
  // We refresh when:
  //   (a) token_expires_at is within 7 days  → proactive refresh before expiry
  //   (b) token_expires_at IS NULL           → connected before we started
  //                                            tracking expiry; refresh to set it
  // We only attempt refresh on status = 'active' — already-expired tokens
  // cannot be refreshed; they need a full OAuth re-authorization from the user.
  const sevenDaysFromNow = new Date(
    Date.now() + 7 * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data: managers, error: fetchErr } = await supabaseAdmin
    .from("meta_business_managers")
    .select("id, business_id, business_name, organization_id, access_token, token_expires_at")
    .eq("status", "active")
    .or(`token_expires_at.is.null,token_expires_at.lte.${sevenDaysFromNow}`);

  if (fetchErr) {
    console.error("DB fetch error:", fetchErr);
    return jsonResponse({ error: "DB fetch failed", detail: fetchErr.message }, 500);
  }

  if (!managers?.length) {
    console.log("No tokens need refreshing.");
    return jsonResponse({ message: "No tokens need refreshing", refreshed: 0, failed: 0 });
  }

  console.log(`Found ${managers.length} business manager(s) to refresh.`);

  const results: RefreshResult[] = [];

  for (const mgr of managers) {
    // ── Call Meta's token extension endpoint ────────────────────────────────
    // fb_exchange_token extends a valid long-lived token for another ~60 days.
    // This ONLY works while the token is still valid. Once expired, the user
    // must re-authorize via the full OAuth flow (the "Reconnect Meta" button).
    let refreshData: Record<string, unknown>;
    try {
      const refreshRes = await fetch(
        `${META_API}/oauth/access_token?` +
          new URLSearchParams({
            grant_type:        "fb_exchange_token",
            client_id:         Deno.env.get("META_APP_ID")!,
            client_secret:     Deno.env.get("META_APP_SECRET")!,
            fb_exchange_token: mgr.access_token,
          }).toString()
      );
      refreshData = await refreshRes.json();
    } catch (networkErr) {
      console.error(`Network error refreshing ${mgr.id}:`, networkErr);
      results.push({
        id: mgr.id, business_name: mgr.business_name, business_id: mgr.business_id,
        outcome: "error", error: (networkErr as Error).message,
      });
      continue;
    }

    // ── Refresh failed (token already expired or app permission revoked) ────
    if (refreshData.error || !refreshData.access_token) {
      const errMsg = (refreshData.error as Record<string, unknown>)?.message as string
        ?? "Token refresh rejected by Meta";
      console.error(`Refresh failed for manager ${mgr.id} (${mgr.business_name}):`, errMsg);

      // Mark as expired so the dashboard shows the "Reconnect Meta" button
      await supabaseAdmin
        .from("meta_business_managers")
        .update({ status: "expired", updated_at: new Date().toISOString() })
        .eq("id", mgr.id);

      results.push({
        id: mgr.id, business_name: mgr.business_name, business_id: mgr.business_id,
        outcome: "failed", error: errMsg,
      });
      continue;
    }

    // ── Persist the refreshed token ─────────────────────────────────────────
    // Meta returns expires_in in seconds. Fall back to 60 days if absent.
    const expiresIn    = refreshData.expires_in as number | undefined;
    const newExpiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();

    const { error: updateErr } = await supabaseAdmin
      .from("meta_business_managers")
      .update({
        access_token:     refreshData.access_token as string,
        token_expires_at: newExpiresAt,
        status:           "active",
        last_verified_at: new Date().toISOString(),
        updated_at:       new Date().toISOString(),
      })
      .eq("id", mgr.id);

    if (updateErr) {
      console.error(`DB update failed for ${mgr.id}:`, updateErr);
      results.push({
        id: mgr.id, business_name: mgr.business_name, business_id: mgr.business_id,
        outcome: "db_error", error: updateErr.message,
      });
      continue;
    }

    // ── Audit log ───────────────────────────────────────────────────────────
    await supabaseAdmin.from("audit_log").insert({
      organization_id: mgr.organization_id,
      action:          "meta.token.auto_refreshed",
      resource_type:   "meta_business_manager",
      resource_id:     mgr.id,
      metadata: {
        business_id:    mgr.business_id,
        business_name:  mgr.business_name,
        old_expires_at: mgr.token_expires_at,
        new_expires_at: newExpiresAt,
      },
    });

    console.log(
      `Refreshed token for ${mgr.business_name ?? mgr.business_id}. ` +
      `New expiry: ${newExpiresAt}`
    );

    results.push({
      id: mgr.id, business_name: mgr.business_name, business_id: mgr.business_id,
      outcome: "refreshed", new_expires_at: newExpiresAt,
    });
  }

  const refreshed = results.filter(r => r.outcome === "refreshed").length;
  const failed    = results.filter(r => r.outcome !== "refreshed").length;

  console.log(`Token refresh run complete: ${refreshed} refreshed, ${failed} failed.`);
  return jsonResponse({ refreshed, failed, results });
});
