/**
 * Accounts Sync — Supabase Edge Function
 * Discovers ad accounts newly granted to the connected Meta token and Google login,
 * and inserts them into meta_ad_accounts / google_ads_accounts so they appear
 * in the dashboard automatically. Also re-links accounts stuck on expired
 * Business Manager connections to the newest active one.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const META_API = "https://graph.facebook.com/v21.0";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Unauthorized" }, 401);
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.replace("Bearer ", ""));
  if (authError || !user) return jsonResponse({ error: "Unauthorized" }, 401);

  let body: { organization_id?: string };
  try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
  const orgId = body.organization_id;
  if (!orgId) return jsonResponse({ error: "organization_id required" }, 400);

  const { data: member } = await supabaseAdmin
    .from("organization_members").select("id")
    .eq("organization_id", orgId).eq("user_id", user.id)
    .not("accepted_at", "is", null).single();
  if (!member) return jsonResponse({ error: "Forbidden" }, 403);

  const result: Record<string, unknown> = { meta_added: 0, meta_relinked: 0, google_added: 0 };

  // ── META ────────────────────────────────────────────
  try {
    const { data: bms } = await supabaseAdmin
      .from("meta_business_managers").select("id, access_token, status, connected_at")
      .eq("organization_id", orgId).eq("status", "active")
      .order("connected_at", { ascending: false }).limit(1);
    const bm = bms?.[0];
    if (bm?.access_token) {
      const fetched: { account_id: string; name?: string; currency?: string; account_status?: number; timezone_name?: string }[] = [];
      let url: string | null = `${META_API}/me/adaccounts?fields=account_id,name,currency,account_status,timezone_name&limit=200&access_token=${bm.access_token}`;
      for (let page = 0; page < 6 && url; page++) {
        const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        const j = await res.json();
        if (j.error) { result.meta_error = j.error.message; url = null; break; }
        fetched.push(...(j.data ?? []));
        url = j.paging?.next ?? null;
      }

      if (fetched.length) {
        const { data: existing } = await supabaseAdmin
          .from("meta_ad_accounts").select("id, meta_account_id, business_manager_id")
          .eq("organization_id", orgId);
        const existingIds = new Set((existing ?? []).map(a => a.meta_account_id));

        const { data: expiredBms } = await supabaseAdmin
          .from("meta_business_managers").select("id")
          .eq("organization_id", orgId).eq("status", "expired");
        const expiredIds = new Set((expiredBms ?? []).map(b => b.id));

        const newRows = fetched.filter(a => !existingIds.has(a.account_id)).map(a => ({
          organization_id: orgId,
          business_manager_id: bm.id,
          meta_account_id: a.account_id,
          account_name: a.name ?? a.account_id,
          currency: a.currency ?? null,
          account_status: a.account_status ?? null,
          timezone: a.timezone_name ?? null,
          is_active: true,
        }));
        if (newRows.length) {
          const { error: insErr } = await supabaseAdmin.from("meta_ad_accounts").insert(newRows);
          if (insErr) result.meta_insert_error = insErr.message;
          else result.meta_added = newRows.length;
        }

        const toRelink = (existing ?? []).filter(a => expiredIds.has(a.business_manager_id)).map(a => a.id);
        if (toRelink.length) {
          const { error: relErr } = await supabaseAdmin
            .from("meta_ad_accounts")
            .update({ business_manager_id: bm.id, updated_at: new Date().toISOString() })
            .in("id", toRelink);
          if (!relErr) result.meta_relinked = toRelink.length;
        }
      }
    }
  } catch (e) { result.meta_error = (e as Error).message; }

  // ── GOOGLE ADS ──────────────────────────────────────
  try {
    const { data: srcRows } = await supabaseAdmin
      .from("google_ads_accounts").select("*")
      .eq("organization_id", orgId).eq("is_active", true).limit(1);
    const src = srcRows?.[0];
    if (src?.refresh_token) {
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: src.client_id, client_secret: src.client_secret, refresh_token: src.refresh_token, grant_type: "refresh_token" }),
        signal: AbortSignal.timeout(10_000),
      });
      const tokenJson = await tokenRes.json();
      const accessToken = tokenJson.access_token as string | undefined;
      if (accessToken) {
        const listRes = await fetch("https://googleads.googleapis.com/v24/customers:listAccessibleCustomers", {
          headers: { "Authorization": `Bearer ${accessToken}`, "developer-token": src.developer_token },
          signal: AbortSignal.timeout(10_000),
        });
        if (listRes.ok) {
          const listJson = await listRes.json();
          const ids: string[] = (listJson.resourceNames ?? []).map((r: string) => r.replace("customers/", ""));
          const { data: gExisting } = await supabaseAdmin
            .from("google_ads_accounts").select("customer_id")
            .eq("organization_id", orgId);
          const gSet = new Set((gExisting ?? []).map(a => String(a.customer_id).replace(/-/g, "")));
          const gNew = ids.filter(id => !gSet.has(id)).map(id => ({
            organization_id: orgId,
            customer_id: id,
            account_name: id,
            client_id: src.client_id,
            client_secret: src.client_secret,
            refresh_token: src.refresh_token,
            developer_token: src.developer_token,
            login_customer_id: src.login_customer_id,
            is_active: true,
          }));
          if (gNew.length) {
            const { error: gErr } = await supabaseAdmin.from("google_ads_accounts").insert(gNew);
            if (gErr) result.google_insert_error = gErr.message;
            else result.google_added = gNew.length;
          }
        } else {
          result.google_error = `listAccessibleCustomers ${listRes.status}`;
        }
      } else {
        result.google_error = tokenJson.error ?? "token refresh failed";
      }
    }
  } catch (e) { result.google_error = (e as Error).message; }

  return jsonResponse(result);
});
