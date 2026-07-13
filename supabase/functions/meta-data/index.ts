/**
 * Meta Data Proxy — Supabase Edge Function
 * Deploy: supabase functions deploy meta-data
 *
 * Fetches Meta Marketing API insights for a given ad account.
 * The browser sends the DB UUID of the account record; this function
 * retrieves the stored access token and Meta account ID server-side,
 * calls the Meta API, and returns normalized data to the dashboard.
 *
 * The Meta access token is never exposed to the browser.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const META_API = "https://graph.facebook.com/v21.0";

// Fields that map to what the dashboard renders
const INSIGHTS_FIELDS = [
  "account_name",
  "spend",
  "impressions",
  "reach",
  "clicks",
  "inline_link_clicks",   // direct link-click count (more reliable than actions array)
  "cpm",
  "cpc",
  "ctr",
  "frequency",
  "actions",
  "cost_per_action_type",
  "cost_per_result",
  "results",
  "date_start",
  "date_stop",
].join(",");

// Campaign-level breakdown fields
const CAMPAIGN_FIELDS = [
  "campaign_id",
  "campaign_name",
  "spend",
  "impressions",
  "reach",
  "clicks",
  "cpm",
  "cpc",
  "ctr",
  "frequency",
  "actions",
  "cost_per_action_type",
  "date_start",
  "date_stop",
].join(",");

// Daily trend fields (used with time_increment=1)
const DAILY_FIELDS = [
  "spend",
  "impressions",
  "reach",
  "clicks",
  "ctr",
  "cpc",
  "cpm",
  "date_start",
].join(",");

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // ── 1. Authenticate ──
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Unauthorized" }, 401);

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(
    authHeader.replace("Bearer ", "")
  );
  if (authError || !user) return jsonResponse({ error: "Unauthorized" }, 401);

  // ── 2. Parse request ──
  let body: {
    account_db_id?: string;  // UUID of the meta_ad_accounts row
    period?: string;          // today | yesterday | this_month | last_month | custom
    custom_from?: string;     // YYYY-MM-DD
    custom_to?: string;       // YYYY-MM-DD
    level?: string;           // "account" (default) | "campaign" | "daily"
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { account_db_id, period = "today", custom_from, custom_to, level = "account" } = body;
  if (!account_db_id) return jsonResponse({ error: "account_db_id is required" }, 400);

  // ── 3. Fetch account + token via Business Manager (service role) ──
  // The access token is stored on meta_business_managers, not on the
  // ad account itself. We join through business_manager_id to get it.
  // We also select the BM's id so we can mark it expired if we get a 190.
  const { data: account, error: accErr } = await supabaseAdmin
    .from("meta_ad_accounts")
    .select(`
      meta_account_id,
      currency,
      organization_id,
      account_name,
      business_manager_id,
      meta_business_managers ( id, access_token, status )
    `)
    .eq("id", account_db_id)
    .eq("is_active", true)
    .single();

  if (accErr || !account) return jsonResponse({ error: "Account not found or inactive" }, 404);

  const bm          = (account as any).meta_business_managers;
  const accessToken = bm?.access_token;
  if (!accessToken) return jsonResponse({ error: "No access token found for this account" }, 422);

  // If the business manager is already marked expired, skip the API call entirely
  // and return immediately so the dashboard can show the reconnect prompt.
  if (bm?.status === "expired") {
    return jsonResponse({ error: "TOKEN_EXPIRED" }, 401);
  }

  // ── Helper: mark a business manager's token as expired ──────────────────────
  // Called whenever Meta returns error code 190 (OAuthException).
  // Uses the service role so it bypasses RLS — this write happens from the
  // Edge Function, not from the browser.
  async function markTokenExpired(bmId: string): Promise<void> {
    await supabaseAdmin
      .from("meta_business_managers")
      .update({ status: "expired", updated_at: new Date().toISOString() })
      .eq("id", bmId);
    console.log(`Marked business manager ${bmId} as expired (Meta error 190)`);
  }

  // Verify org membership
  const { data: member } = await supabaseAdmin
    .from("organization_members")
    .select("id")
    .eq("organization_id", account.organization_id)
    .eq("user_id", user.id)
    .not("accepted_at", "is", null)
    .single();

  if (!member) return jsonResponse({ error: "Forbidden" }, 403);

  // ── 4. Build Meta API date parameters ──
  const META_DATE_PRESETS: Record<string, string> = {
    today: "today",
    yesterday: "yesterday",
    this_month: "this_month",
    last_month: "last_month",
  };

  const dateParams: Record<string, string> =
    period === "custom" && custom_from && custom_to
      ? { time_range: JSON.stringify({ since: custom_from, until: custom_to }) }
      : { date_preset: META_DATE_PRESETS[period] ?? "today" };

  // ── 5. Call Meta Marketing API (branched by level) ──────────────

  async function callMeta(fields: string, extra: Record<string, string> = {}): Promise<unknown> {
    const p = new URLSearchParams({ fields, access_token: accessToken, ...dateParams, ...extra });
    let res: Response;
    try {
      res = await fetch(`${META_API}/act_${account.meta_account_id}/insights?${p.toString()}`);
    } catch (e) {
      console.error("Meta API unreachable:", e);
      throw new Error("Meta API unreachable");
    }
    const body = await res.json();
    if (body.error) {
      // Error code 190 (OAuthException) = token expired, invalid, or revoked.
      // Throw a typed error so each calling branch can handle it uniformly.
      if (body.error.code === 190 || body.error.type === "OAuthException") {
        throw Object.assign(new Error("TOKEN_EXPIRED"), { isTokenExpired: true });
      }
      throw new Error(body.error.message ?? "Meta API error");
    }
    return body;
  }

  // ── level = "campaign": per-campaign breakdown ──────────────────
  if (level === "campaign") {
    let metaBody: Record<string, unknown>;
    try {
      metaBody = await callMeta(CAMPAIGN_FIELDS, { level: "campaign", limit: "50" }) as Record<string, unknown>;
    } catch (e: unknown) {
      const err = e as Error & { isTokenExpired?: boolean };
      if (err.isTokenExpired) {
        if (bm?.id) await markTokenExpired(bm.id);
        return jsonResponse({ error: "TOKEN_EXPIRED" }, 401);
      }
      return jsonResponse({ error: err.message }, 502);
    }

    const campaigns = ((metaBody.data as Record<string, unknown>[]) ?? []).map(c => {
      const acts: Record<string, string> = {};
      for (const a of (c.actions as {action_type:string;value:string}[]) ?? []) acts[a.action_type] = a.value;
      const cpa: Record<string, string> = {};
      for (const a of (c.cost_per_action_type as {action_type:string;value:string}[]) ?? []) cpa[a.action_type] = a.value;
      return {
        campaign_id:   c.campaign_id,
        campaign_name: c.campaign_name,
        spend:        c.spend,
        impressions:  c.impressions,
        reach:        c.reach,
        clicks:       c.clicks,
        ctr:          c.ctr,
        cpc:          c.cpc,
        cpm:          c.cpm,
        frequency:    c.frequency,
        date_start:   c.date_start,
        date_stop:    c.date_stop,
        "actions:link_click":       acts["link_click"] ?? null,
        "actions:page_engagement":  acts["page_engagement"] ?? null,
        "cost_per_action_type:link_click": cpa["link_click"] ?? null,
      };
    });

    return jsonResponse({ campaigns, currency: account.currency });
  }

  // ── level = "daily": time-series (one row per day) ──────────────
  if (level === "daily") {
    let metaBody: Record<string, unknown>;
    try {
      metaBody = await callMeta(DAILY_FIELDS, { time_increment: "1" }) as Record<string, unknown>;
    } catch (e: unknown) {
      const err = e as Error & { isTokenExpired?: boolean };
      if (err.isTokenExpired) {
        if (bm?.id) await markTokenExpired(bm.id);
        return jsonResponse({ error: "TOKEN_EXPIRED" }, 401);
      }
      return jsonResponse({ error: err.message }, 502);
    }

    const daily = ((metaBody.data as Record<string, unknown>[]) ?? []).map(d => ({
      date:        d.date_start as string,
      spend:       (d.spend       as string) || "0",
      impressions: (d.impressions as string) || "0",
      reach:       (d.reach       as string) || "0",
      clicks:      (d.clicks      as string) || "0",
      ctr:         (d.ctr         as string) || "0",
      cpc:         (d.cpc         as string) || "0",
      cpm:         (d.cpm         as string) || "0",
    }));

    return jsonResponse({ daily, currency: account.currency });
  }

  // ── level = "platform": publisher_platform breakdown ────────────────
  if (level === "platform") {
    const PLATFORM_FIELDS = "spend,impressions,reach,clicks,actions,cost_per_action_type";
    let platBody: Record<string, unknown>;
    try {
      platBody = await callMeta(PLATFORM_FIELDS, { breakdowns: "publisher_platform" }) as Record<string, unknown>;
    } catch (e: unknown) {
      const err = e as Error & { isTokenExpired?: boolean };
      if (err.isTokenExpired) { if (bm?.id) await markTokenExpired(bm.id); return jsonResponse({ error: "TOKEN_EXPIRED" }, 401); }
      return jsonResponse({ error: err.message }, 502);
    }
    const platforms = ((platBody.data as Record<string, unknown>[]) ?? []).map(p => {
      const acts: Record<string, string> = {};
      for (const a of (p.actions as {action_type: string; value: string}[]) ?? []) acts[a.action_type] = a.value;
      const cpa: Record<string, string> = {};
      for (const a of (p.cost_per_action_type as {action_type: string; value: string}[]) ?? []) cpa[a.action_type] = a.value;
      return {
        platform:        p.publisher_platform as string,
        spend:           p.spend,
        impressions:     p.impressions,
        reach:           p.reach,
        clicks:          p.clicks,
        results:         acts["link_click"] ?? acts["omni_purchase"] ?? null,
        cost_per_result: cpa["link_click"]  ?? cpa["omni_purchase"]  ?? null,
      };
    }).sort((a, b) => parseFloat(String(b.spend ?? 0)) - parseFloat(String(a.spend ?? 0)));
    return jsonResponse({ platforms, currency: account.currency });
  }

  // ── level = "region": geographic breakdown ───────────────────────────
  if (level === "region") {
    const REGION_FIELDS = "spend,impressions,reach,clicks,actions,cost_per_action_type";
    let regBody: Record<string, unknown>;
    try {
      regBody = await callMeta(REGION_FIELDS, { breakdowns: "region", limit: "50" }) as Record<string, unknown>;
    } catch (e: unknown) {
      const err = e as Error & { isTokenExpired?: boolean };
      if (err.isTokenExpired) { if (bm?.id) await markTokenExpired(bm.id); return jsonResponse({ error: "TOKEN_EXPIRED" }, 401); }
      return jsonResponse({ error: err.message }, 502);
    }
    const regions = ((regBody.data as Record<string, unknown>[]) ?? []).map(r => {
      const acts: Record<string, string> = {};
      for (const a of (r.actions as {action_type: string; value: string}[]) ?? []) acts[a.action_type] = a.value;
      const cpa: Record<string, string> = {};
      for (const a of (r.cost_per_action_type as {action_type: string; value: string}[]) ?? []) cpa[a.action_type] = a.value;
      return {
        region:          r.region as string,
        spend:           r.spend,
        impressions:     r.impressions,
        results:         acts["link_click"] ?? acts["omni_purchase"] ?? null,
        cost_per_result: cpa["link_click"]  ?? cpa["omni_purchase"]  ?? null,
      };
    }).sort((a, b) => parseFloat(String(b.spend ?? 0)) - parseFloat(String(a.spend ?? 0)));
    return jsonResponse({ regions, currency: account.currency });
  }

  // ── level = "ad": per-ad breakdown ──────────────────────────────────
  if (level === "ad") {
    const AD_FIELDS = "ad_id,ad_name,spend,impressions,clicks,actions,cost_per_action_type";
    let adBody: Record<string, unknown>;
    try {
      adBody = await callMeta(AD_FIELDS, { level: "ad", limit: "50" }) as Record<string, unknown>;
    } catch (e: unknown) {
      const err = e as Error & { isTokenExpired?: boolean };
      if (err.isTokenExpired) { if (bm?.id) await markTokenExpired(bm.id); return jsonResponse({ error: "TOKEN_EXPIRED" }, 401); }
      return jsonResponse({ error: err.message }, 502);
    }
    const ads = ((adBody.data as Record<string, unknown>[]) ?? []).map(a => {
      const acts: Record<string, string> = {};
      for (const act of (a.actions as {action_type: string; value: string}[]) ?? []) acts[act.action_type] = act.value;
      const cpa: Record<string, string> = {};
      for (const act of (a.cost_per_action_type as {action_type: string; value: string}[]) ?? []) cpa[act.action_type] = act.value;
      return {
        ad_id:           a.ad_id as string,
        ad_name:         a.ad_name as string,
        spend:           a.spend,
        impressions:     a.impressions,
        clicks:          a.clicks,
        results:         acts["link_click"] ?? acts["omni_purchase"] ?? null,
        cost_per_result: cpa["link_click"]  ?? cpa["omni_purchase"]  ?? null,
      };
    });
    return jsonResponse({ ads, currency: account.currency });
  }

  // ── level = "account" (default): existing aggregate behaviour ───
  let metaRes: Response;
  try {
    const params = new URLSearchParams({
      fields: INSIGHTS_FIELDS,
      level: "account",
      access_token: accessToken,
      ...dateParams,
    });
    metaRes = await fetch(
      `${META_API}/act_${account.meta_account_id}/insights?${params.toString()}`
    );
  } catch (e) {
    console.error("Meta API unreachable:", e);
    return jsonResponse({ error: "Meta API unreachable" }, 502);
  }

  const metaBody = await metaRes.json();

  if (metaBody.error) {
    console.error("Meta API error:", metaBody.error);
    // Error code 190 (OAuthException) = token expired or revoked
    if (metaBody.error.code === 190 || metaBody.error.type === "OAuthException") {
      if (bm?.id) await markTokenExpired(bm.id);
      return jsonResponse({ error: "TOKEN_EXPIRED" }, 401);
    }
    return jsonResponse({ error: metaBody.error.message ?? "Meta API error" }, 422);
  }

  const insight = metaBody.data?.[0] ?? {};

  // ── 6. Normalize: build action lookup maps ──
  const actions: Record<string, string> = {};
  for (const a of insight.actions ?? []) actions[a.action_type] = a.value;

  const costPerAction: Record<string, string> = {};
  for (const a of insight.cost_per_action_type ?? []) costPerAction[a.action_type] = a.value;

  // ── 7. Return shape that the dashboard's parse logic expects ──
  return jsonResponse({
    ad_entity: {
      id: `act_${account.meta_account_id}`,
      name: insight.account_name ?? account.account_name ?? account.meta_account_id,
      date_start: insight.date_start,
      date_stop: insight.date_stop,

      // Primary spend
      amount_spent: insight.spend,

      // Reach & engagement
      impressions: insight.impressions,
      reach: insight.reach,
      clicks: insight.clicks,
      cpm: insight.cpm,
      cpc: insight.cpc,
      ctr: insight.ctr,
      frequency: insight.frequency,

      // Results (messages / leads / purchases — context-dependent)
      // cost_per_result is an array [{action_type, value}]; extract first value
      results:          insight.results?.[0]?.value         ?? null,
      cost_per_result:  insight.cost_per_result?.[0]?.value ?? null,

      // Action breakdowns (inline_link_clicks is a reliable direct field fallback)
      "actions:like":             actions["like"]            ?? null,
      "actions:page_engagement":  actions["page_engagement"] ?? null,
      "actions:comment":          actions["comment"]         ?? null,
      "actions:post_reaction":    actions["post_reaction"]   ?? null,
      "actions:link_click":       actions["link_click"]      ?? insight.inline_link_clicks ?? null,

      // Cost per action
      "cost_per_action_type:page_engagement": costPerAction["page_engagement"] ?? null,
      "cost_per_action_type:like":            costPerAction["like"] ?? null,
    },
    currency: account.currency,
  });
});
