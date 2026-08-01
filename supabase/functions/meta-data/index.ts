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
  "results",
  "cost_per_result",
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
      facebook_page_id,
      meta_business_managers ( id, access_token, status )
    `)
    .eq("id", account_db_id)
    .eq("is_active", true)
    .single();

  if (accErr || !account) return jsonResponse({ error: "Account not found or inactive" }, 404);

  const bm          = (account as any).meta_business_managers;
  const accessToken = bm?.access_token;
  if (!accessToken) return jsonResponse({ error: "No access token found for this account" }, 422);

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
  // Meta Marketing API date_preset values:
  //   today, yesterday, last_7_days, last_14_days, last_28_days, last_30_days,
  //   last_90_days, this_month, last_month, this_quarter, last_quarter,
  //   this_year, last_year, last_3d, last_7d, last_14d, last_28d, last_30d
  const META_DATE_PRESETS: Record<string, string> = {
    today:        "today",
    yesterday:    "yesterday",
    last_7_days:  "last_7_days",
    last_30_days: "last_30_days",
    this_month:   "this_month",
    last_month:   "last_month",
    this_quarter: "this_quarter",
    last_quarter: "last_quarter",
    this_year:    "this_year",
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
      metaBody = await callMeta(CAMPAIGN_FIELDS, {
        level:     "campaign",
        limit:     "50",
        filtering: JSON.stringify([{ field: "campaign.effective_status", operator: "IN", value: ["ACTIVE"] }]),
      }) as Record<string, unknown>;
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
      // Meta returns results/cost_per_result as [{action_type, value}] arrays
      const resultsArr     = (c.results         as {action_type:string;value:string}[]) ?? [];
      const cprArr         = (c.cost_per_result  as {action_type:string;value:string}[]) ?? [];
      const resultsVal     = resultsArr[0]?.value ?? null;
      const costPerResult  = cprArr[0]?.value     ?? null;
      // Messaging: conversations started (7-day click window)
      const MSG_KEY = "onsite_conversion.messaging_conversation_started_7d";
      return {
        campaign_id:      c.campaign_id,
        campaign_name:    c.campaign_name,
        spend:            c.spend,
        impressions:      c.impressions,
        reach:            c.reach,
        clicks:           c.clicks,
        ctr:              c.ctr,
        cpc:              c.cpc,
        cpm:              c.cpm,
        frequency:        c.frequency,
        date_start:       c.date_start,
        date_stop:        c.date_stop,
        results:          resultsVal,
        cost_per_result:  costPerResult,
        messages:         acts[MSG_KEY] ?? null,
        cost_per_message: cpa[MSG_KEY]  ?? null,
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
  let balanceRes: Response;
  let campaignsRes: Response;
  try {
    const params = new URLSearchParams({
      fields: INSIGHTS_FIELDS,
      level: "account",
      access_token: accessToken,
      ...dateParams,
    });
    const campaignFilter = JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]);
    // Fetch insights + account balance + active campaign budgets in parallel
    [metaRes, balanceRes, campaignsRes] = await Promise.all([
      fetch(`${META_API}/act_${account.meta_account_id}/insights?${params.toString()}`),
      fetch(`${META_API}/act_${account.meta_account_id}?fields=balance,currency,spend_cap,amount_spent,funding_source_details{display_string,type}&access_token=${accessToken}`),
      fetch(`${META_API}/act_${account.meta_account_id}/campaigns?fields=daily_budget,lifetime_budget,effective_status&filtering=${encodeURIComponent(campaignFilter)}&limit=50&access_token=${accessToken}`),
    ]);
  } catch (e) {
    console.error("Meta API unreachable:", e);
    return jsonResponse({ error: "Meta API unreachable" }, 502);
  }

  const metaBody = await metaRes.json();
  const balanceBody = await balanceRes.json().catch(() => ({}));
  const campaignsBody = await campaignsRes.json().catch(() => ({}));

  // balance is returned in cents by Meta — divide by 100 for display
  const accountBalance = balanceBody.balance != null
    ? parseFloat(balanceBody.balance) / 100
    : null;
  const spendCap = balanceBody.spend_cap != null && parseFloat(balanceBody.spend_cap) > 0
    ? parseFloat(balanceBody.spend_cap) / 100
    : null;

  // Sum daily budgets of all active campaigns (also in cents)
  const totalDailyBudgetCents = ((campaignsBody.data ?? []) as { daily_budget?: string }[])
    .filter(c => c.daily_budget && parseInt(c.daily_budget) > 0)
    .reduce((sum, c) => sum + parseInt(c.daily_budget!), 0);
  const totalDailyBudget = totalDailyBudgetCents > 0 ? totalDailyBudgetCents / 100 : null;

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

  // ── 7. Fetch Business Suite page messages (total conversations, not just ad-attributed) ──
  // Converts period → actual YYYY-MM-DD dates for the Page Insights API
  function periodToDates(p: string, cf?: string, ct?: string): { since: string; until: string } {
    const pad = (n: number) => String(n).padStart(2, "0");
    const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const now  = new Date();
    const today     = fmt(now);
    const yesterday = fmt(new Date(now.getTime() - 86_400_000));
    switch (p) {
      case "yesterday":    return { since: yesterday, until: yesterday };
      case "last_7_days":  return { since: fmt(new Date(now.getTime() - 7  * 86_400_000)), until: today };
      case "last_30_days": return { since: fmt(new Date(now.getTime() - 30 * 86_400_000)), until: today };
      case "this_month":   return { since: fmt(new Date(now.getFullYear(), now.getMonth(), 1)), until: today };
      case "last_month":   return { since: fmt(new Date(now.getFullYear(), now.getMonth() - 1, 1)), until: fmt(new Date(now.getFullYear(), now.getMonth(), 0)) };
      case "this_quarter": { const q = Math.floor(now.getMonth() / 3); return { since: fmt(new Date(now.getFullYear(), q * 3, 1)), until: today }; }
      case "this_year":    return { since: fmt(new Date(now.getFullYear(), 0, 1)), until: today };
      case "custom":       return { since: cf ?? today, until: ct ?? today };
      default:             return { since: today, until: today }; // "today"
    }
  }

  let pageMessages: number | null = null;
  let messageSource: "business_suite" | "meta_ads" | null = null;
  const _debugPageInsights: Record<string, unknown> = {};

  // page_messages_new_conversation_unique has a 24-48h reporting delay on Facebook's side.
  // For "today", this metric is always 0 regardless of actual conversations.
  // Skip the BM lookup entirely for "today" — saves ~1-2s of API calls and avoids showing 0.
  const skipPageInsights = (period === "today");
  if (skipPageInsights) {
    console.log("Skipping page insights for 'today' period (24-48h delay on this metric)");
  }

  try {
    // App Access Token — same app used for meta-oauth.
    // App tokens can query BM pages regardless of what scopes the stored user/system-user token has.
    const META_APP_ID     = Deno.env.get("META_APP_ID");
    const META_APP_SECRET = Deno.env.get("META_APP_SECRET");
    const appToken = (META_APP_ID && META_APP_SECRET) ? `${META_APP_ID}|${META_APP_SECRET}` : null;
    console.log("App token available:", !!appToken);

    // Helper: fetch page insights. Tries to get a page-specific access token first,
    // since page insights require a user token or page token (not an app token).
    const fetchPageInsights = async (pageId: string): Promise<number | null> => {
      const { since, until } = periodToDates(period, custom_from, custom_to);
      _debugPageInsights.pageId = pageId;
      _debugPageInsights.since  = since;
      _debugPageInsights.until  = until;

      // Exchange for a page access token.
      // Try user token first, then App Token (APP_ID|APP_SECRET) as fallback —
      // the App Token can get a page token for any page that has the app installed.
      let pageToken = accessToken;
      try {
        const ptRes  = await fetch(`${META_API}/${pageId}?fields=access_token&access_token=${accessToken}`);
        const ptData = await ptRes.json();
        if (ptData.access_token) {
          pageToken = ptData.access_token;
          _debugPageInsights.pageTokenSource = "user_token";
        } else if (appToken) {
          const aptRes  = await fetch(`${META_API}/${pageId}?fields=access_token&access_token=${appToken}`);
          const aptData = await aptRes.json();
          if (aptData.access_token) {
            pageToken = aptData.access_token;
            _debugPageInsights.pageTokenSource = "app_token";
          } else {
            _debugPageInsights.pageTokenSource = "none";
            _debugPageInsights.pageTokenError = aptData.error?.message ?? ptData.error?.message ?? "no token";
          }
        } else {
          _debugPageInsights.pageTokenSource = "fallback_user";
          _debugPageInsights.pageTokenError = ptData.error?.message ?? "no access_token field";
        }
      } catch (_) { _debugPageInsights.pageTokenSource = "error"; }

      const iParams = new URLSearchParams({
        metric: "page_messages_new_conversation_unique",
        period: "day",
        since,
        until,
        access_token: pageToken,
      });
      const iRes  = await fetch(`${META_API}/${pageId}/insights?${iParams}`);
      const iData = await iRes.json();
      _debugPageInsights.rawInsightsResponse = iData;
      if (iData.error) {
        console.log("Page insights error for", pageId, ":", iData.error.message);
        _debugPageInsights.insightsError = iData.error.message;
        return null;
      }
      const vals  = (iData.data?.[0]?.values ?? []) as { value: number }[];
      const total = vals.reduce((s, v) => s + (v.value || 0), 0);
      _debugPageInsights.total = total;
      console.log("Page insights total for", pageId, ":", total);
      return total > 0 ? total : null;
    };

    if (!skipPageInsights) {
      // 7a. Use stored facebook_page_id if available (fastest path, no discovery needed)
      const storedPageId = (account as any).facebook_page_id as string | undefined;
      if (storedPageId) {
        console.log("Using stored page ID:", storedPageId);
        pageMessages = await fetchPageInsights(storedPageId);
        if (pageMessages !== null) messageSource = "business_suite";
        console.log("pageMessages via stored page ID:", pageMessages);
      }

      if (pageMessages === null) {
      // 7b. Get Business ID from the ad account
      const bizRes  = await fetch(`${META_API}/act_${account.meta_account_id}?fields=business&access_token=${accessToken}`);
      const bizData = await bizRes.json();
      const businessId = bizData.business?.id as string | undefined;
      console.log("BM ID:", businessId ?? "none");

      if (businessId) {
        // Use App Token for BM page lookups — broadest access, no user-scope dependency
        const lookupToken = appToken ?? accessToken;

        // 7b-1. owned_pages via App Token
        const ownedRes  = await fetch(`${META_API}/${businessId}/owned_pages?fields=id,name&limit=10&access_token=${lookupToken}`);
        const ownedData = await ownedRes.json();
        let pageId = ownedData.data?.[0]?.id as string | undefined;
        console.log("owned_pages:", ownedData.data?.length ?? 0, "| error:", ownedData.error?.message ?? "none");

        // 7b-2. client_pages
        if (!pageId) {
          const clientRes  = await fetch(`${META_API}/${businessId}/client_pages?fields=id,name&limit=10&access_token=${lookupToken}`);
          const clientData = await clientRes.json();
          pageId = clientData.data?.[0]?.id as string | undefined;
          console.log("client_pages:", clientData.data?.length ?? 0, "| error:", clientData.error?.message ?? "none");
        }

        // 7b-3. /pages on the business
        if (!pageId) {
          const bpRes  = await fetch(`${META_API}/${businessId}/pages?fields=id,name&limit=10&access_token=${lookupToken}`);
          const bpData = await bpRes.json();
          pageId = bpData.data?.[0]?.id as string | undefined;
          console.log("business /pages:", bpData.data?.length ?? 0, "| error:", bpData.error?.message ?? "none");
        }

        if (pageId) {
          pageMessages = await fetchPageInsights(pageId);
          if (pageMessages !== null) messageSource = "business_suite";
          console.log("pageMessages via BM:", pageMessages, "from page", pageId);
        }
      }

      // 7c. Final fallback: /me/accounts — pages the token user directly administers
      if (pageMessages === null) {
        const meRes  = await fetch(`${META_API}/me/accounts?fields=id,name&limit=10&access_token=${accessToken}`);
        const meData = await meRes.json();
        const pages  = (meData.data ?? []) as { id: string; name: string }[];
        console.log("me/accounts pages:", pages.length, "| error:", meData.error?.message ?? "none");
        for (const page of pages) {
          const result = await fetchPageInsights(page.id);
          if (result !== null) {
            pageMessages = result;
            messageSource = "business_suite";
            console.log("pageMessages via me/accounts:", pageMessages, "from page", page.id);
            break;
          }
        }
      }
      } // end if (pageMessages === null) BM discovery block
    }
  } catch (e) {
    console.log("Page messages fetch failed:", e);
  }

  // Determine final message source for dashboard labeling
  if (messageSource === null) {
    messageSource = actions["onsite_conversion.messaging_conversation_started_7d"] != null ? "meta_ads" : null;
  }

  // ── 8. Return shape that the dashboard's parse logic expects ──
  const adSpend = parseFloat(insight.spend ?? "0") || 0;
  return jsonResponse({
    ad_entity: {
      id: `act_${account.meta_account_id}`,
      name: insight.account_name ?? account.account_name ?? account.meta_account_id,
      date_start: insight.date_start,
      date_stop: insight.date_stop,

      // Account balance (prepaid fund remaining)
      account_balance:  accountBalance,
      spend_cap:        spendCap,
      daily_budget:     totalDailyBudget,
      account_currency: balanceBody.currency ?? account.currency ?? null,
      funding_source:   balanceBody.funding_source_details?.display_string ?? null,
      lifetime_spent:   balanceBody.amount_spent != null ? parseFloat(balanceBody.amount_spent) / 100 : null,

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
      results:          insight.results?.[0]?.value         ?? null,
      cost_per_result:  insight.cost_per_result?.[0]?.value ?? null,

      // Business Suite total messages (page_messages_new_conversation_unique) — primary source
      // Falls back to ad-attributed 7d-click action if page insights unavailable
      page_messages:    pageMessages,
      messages:         actions["onsite_conversion.messaging_conversation_started_7d"] ?? null,
      message_source:   messageSource,   // "business_suite" | "meta_ads" | null
      cost_per_message: pageMessages && adSpend ? String(adSpend / pageMessages) : (costPerAction["onsite_conversion.messaging_conversation_started_7d"] ?? null),

      // Action breakdowns
      "actions:like":             actions["like"]            ?? null,
      "actions:page_engagement":  actions["page_engagement"] ?? null,
      "actions:comment":          actions["comment"]         ?? null,
      "actions:post_reaction":    actions["post_reaction"]   ?? null,
      "actions:link_click":       actions["link_click"]      ?? insight.inline_link_clicks ?? null,

      // Cost per action
      "cost_per_action_type:page_engagement": costPerAction["page_engagement"] ?? null,
      "cost_per_action_type:like":            costPerAction["like"] ?? null,
      "cost_per_action_type:omni_purchase":   costPerAction["omni_purchase"] ?? costPerAction["offsite_conversion.fb_pixel_purchase"] ?? null,
      "actions:omni_purchase":               actions["omni_purchase"] ?? actions["offsite_conversion.fb_pixel_purchase"] ?? null,
    },
    currency: account.currency,
    _debug_page_insights: _debugPageInsights,
  });
});
