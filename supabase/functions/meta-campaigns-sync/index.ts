/**
 * meta-campaigns-sync — Supabase Edge Function
 *
 * Decides whether each Meta ad account is running, and writes
 * has_active_campaigns + campaigns_last_synced_at. The dashboard's
 * Running / Not running tabs read that flag.
 *
 * ── Why it stopped being "any ACTIVE campaign right now" ──────────────
 *
 * It asked Meta for one campaign with effective_status ACTIVE and took the
 * answer as final. That is a reading of a single instant, and the sync runs
 * in the middle of the night: Ibriz - BlueAd2 was marked not running at
 * 00:42 Cairo while it had spent EGP 2,021 that day and 4,070 the day
 * before. An account whose campaigns are paused overnight and resumed each
 * morning would be filed as not running every single time.
 *
 * So the question is asked twice. A live campaign still means running. Where
 * there is none, the account is asked what it has spent over the last three
 * days, and spend means running whatever the campaigns say at this moment —
 * money left the account, so it was live.
 *
 * The cost is one extra call for the accounts that look idle, and those are
 * exactly the accounts where the first answer cannot be trusted.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const META_API = "https://graph.facebook.com/v21.0";
// Enough to cover a weekend pause without calling a long-dead account live.
const SPEND_LOOKBACK = "last_3d";
// Meta is rate-limited per app, and this runs over every account in the org.
const BATCH = 6;

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

type Verdict = {
  account_id: string;
  has_active: boolean | null;
  basis?: "campaign" | "recent_spend" | null;
  spend?: number;
  error?: string;
};

/** Is there a campaign Meta currently calls ACTIVE? */
async function hasLiveCampaign(metaAccountId: string, token: string) {
  const params = new URLSearchParams({
    fields: "id",
    effective_status: JSON.stringify(["ACTIVE"]),
    limit: "1",
    access_token: token,
  });
  const res = await fetch(`${META_API}/act_${metaAccountId}/campaigns?${params}`, {
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "campaigns lookup failed");
  return (data.data?.length ?? 0) > 0;
}

/**
 * What has this account spent recently?
 *
 * Only asked when no campaign is live, which is the case the campaign check
 * gets wrong. Meta returns an empty data array rather than a zero for an
 * account with no delivery, so absence is read as zero rather than an error.
 */
async function recentSpend(metaAccountId: string, token: string) {
  const params = new URLSearchParams({
    fields: "spend",
    date_preset: SPEND_LOOKBACK,
    access_token: token,
  });
  const res = await fetch(`${META_API}/act_${metaAccountId}/insights?${params}`, {
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "insights lookup failed");
  return parseFloat(data.data?.[0]?.spend ?? "0") || 0;
}

// deno-lint-ignore no-explicit-any
async function verdictFor(account: any): Promise<Verdict> {
  const bm = account.meta_business_managers;
  const token = bm?.access_token;
  const id = String(account.meta_account_id);

  if (!token || bm?.status === "expired") {
    return { account_id: id, has_active: null, error: "no_token" };
  }

  try {
    if (await hasLiveCampaign(id, token)) {
      return { account_id: id, has_active: true, basis: "campaign" };
    }
  } catch (e) {
    // An API error must not reset the flag — the old value is better than a
    // wrong new one, which is how an account disappears from the list.
    return { account_id: id, has_active: null, error: (e as Error).message };
  }

  try {
    const spend = await recentSpend(id, token);
    return spend > 0
      ? { account_id: id, has_active: true, basis: "recent_spend", spend }
      : { account_id: id, has_active: false, basis: null, spend: 0 };
  } catch (e) {
    // The campaign check succeeded and said no. Without the spend check to
    // confirm it, that is exactly the reading that was wrong before, so the
    // flag is left alone rather than set to false on half the evidence.
    return { account_id: id, has_active: null, error: (e as Error).message };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Unauthorized" }, 401);

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(
    authHeader.replace("Bearer ", ""),
  );
  if (authError || !user) return jsonResponse({ error: "Unauthorized" }, 401);

  let body: { organization_id?: string };
  try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }

  const { organization_id } = body;
  if (!organization_id) return jsonResponse({ error: "organization_id is required" }, 400);

  const { data: member } = await supabaseAdmin
    .from("organization_members")
    .select("id")
    .eq("organization_id", organization_id)
    .eq("user_id", user.id)
    .not("accepted_at", "is", null)
    .maybeSingle();
  if (!member) return jsonResponse({ error: "Forbidden" }, 403);

  const { data: accounts, error: accErr } = await supabaseAdmin
    .from("meta_ad_accounts")
    .select(`
      id,
      meta_account_id,
      business_manager_id,
      meta_business_managers ( access_token, status )
    `)
    .eq("organization_id", organization_id)
    .eq("is_active", true);

  if (accErr) return jsonResponse({ error: accErr.message }, 500);
  if (!accounts?.length) return jsonResponse({ synced: 0, total: 0 });

  // Sequential over a hundred accounts, each now up to two calls, ran long
  // enough to risk the function timing out and writing nothing at all.
  const results: Verdict[] = [];
  // deno-lint-ignore no-explicit-any
  const byId = new Map((accounts as any[]).map((a: any) => [String(a.meta_account_id), a.id]));

  for (let i = 0; i < accounts.length; i += BATCH) {
    const slice = accounts.slice(i, i + BATCH);
    const verdicts: Verdict[] = await Promise.all(slice.map(verdictFor));
    const writable = verdicts.filter((v: Verdict) => v.has_active !== null);
    await Promise.all(writable.map((v: Verdict) =>
      supabaseAdmin.from("meta_ad_accounts").update({
        has_active_campaigns: v.has_active,
        campaigns_last_synced_at: new Date().toISOString(),
      }).eq("id", byId.get(v.account_id)!)
    ));
    results.push(...verdicts);
  }

  return jsonResponse({
    synced: results.filter(r => r.has_active !== null).length,
    total: accounts.length,
    running: results.filter(r => r.has_active === true).length,
    // How many were only caught by the spend check — these are the accounts
    // the old logic was filing as idle.
    running_on_spend_alone: results.filter(r => r.basis === "recent_spend").length,
    skipped: results.filter(r => r.has_active === null).length,
    results,
  });
});
