/**
 * Meta Data Proxy — Supabase Edge Function
 *
 * Fetches Meta Marketing API insights for a given ad account.
 * The Meta access token is never exposed to the browser.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const META_API = "https://graph.facebook.com/v21.0";

const INSIGHTS_FIELDS = [
  "account_name", "spend", "impressions", "reach", "clicks",
  "inline_link_clicks", "cpm", "cpc", "ctr", "frequency",
  "actions", "cost_per_action_type", "cost_per_result", "results",
  "date_start", "date_stop",
].join(",");

const CAMPAIGN_FIELDS = [
  "campaign_id", "campaign_name", "spend", "impressions", "reach", "clicks",
  "cpm", "cpc", "ctr", "frequency", "actions", "cost_per_action_type",
  "results", "cost_per_result", "date_start", "date_stop",
].join(",");

const DAILY_FIELDS = [
  "spend", "impressions", "reach", "clicks", "ctr", "cpc", "cpm", "date_start",
].join(",");

// ── What counts as a "result" ──────────────────────────────────────
// Meta reports `results` against the ad set's optimisation goal — a purchase
// for a sales campaign, a conversation for a messaging one. Where the API
// returns it (account and campaign level) that is the figure to show.
//
// Breakdowns and ad rows do not carry it, so those fall back to the action
// types below. The ORDER is the thing that was wrong: the list used to lead
// with link_click, the cheapest action Meta returns, so a cost per click was
// displayed wherever a cost per purchase or per conversation belonged. On a
// Shopify account that showed EGP 8 against a real cost per purchase of over
// EGP 300. link_click is now last, and only stands in when nothing else was
// tracked at all.
const RESULT_PRIORITY = [
  "omni_purchase",
  "offsite_conversion.fb_pixel_purchase",
  "onsite_conversion.messaging_conversation_started_7d",
  "lead",
  "onsite_conversion.lead_grouped",
  "complete_registration",
  "add_to_cart",
  "landing_page_view",
  "link_click",
];

// ── Awareness-side action types ────────────────────────────────────
// Meta names these differently across placements and has renamed them between
// API versions, so each metric takes the first name that actually came back
// rather than one hard-coded guess. The whole action map is returned as
// `actions_all` so a name missing from these lists can be found from real data
// instead of guessed at, and `*_basis` records which name was used.
const VIDEO_VIEW_KEYS = [
  "video_view",
];
const PROFILE_VISIT_KEYS = [
  "profile_visit",
  "onsite_conversion.ig_profile_visit",
  "instagram_profile_visit",
  "onsite_conversion.profile_visit",
];
// `like` is a Facebook page like, which is a follow — but it is the loosest
// match here, so it is tried last and the basis records that it was used.
const FOLLOW_KEYS = [
  "follow",
  "onsite_conversion.follow",
  "page_like",
  "like",
];

function firstOf(
  map: Record<string, string>,
  keys: string[],
): { value: string | null; basis: string | null } {
  for (const k of keys) if (map[k] != null) return { value: map[k], basis: k };
  return { value: null, basis: null };
}

function firstValue(v: unknown): string | null {
  const arr = v as { value?: string }[] | undefined;
  return Array.isArray(arr) && arr.length ? (arr[0]?.value ?? null) : null;
}

/** Meta's own result for the objective when present; otherwise the most valuable tracked action. */
function pickResult(
  row: Record<string, unknown>,
  acts: Record<string, string>,
  cpa: Record<string, string>,
): { results: string | null; cost_per_result: string | null; result_basis: string | null } {
  const r  = firstValue(row.results);
  const cr = firstValue(row.cost_per_result);
  if (r != null || cr != null) return { results: r, cost_per_result: cr, result_basis: "meta_objective" };
  for (const k of RESULT_PRIORITY) {
    if (acts[k] != null) return { results: acts[k], cost_per_result: cpa[k] ?? null, result_basis: k };
  }
  return { results: null, cost_per_result: null, result_basis: null };
}

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

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Unauthorized" }, 401);

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(
    authHeader.replace("Bearer ", "")
  );
  if (authError || !user) return jsonResponse({ error: "Unauthorized" }, 401);

  let body: {
    account_db_id?: string;
    period?: string;
    custom_from?: string;
    custom_to?: string;
    level?: string;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { account_db_id, period = "today", custom_from, custom_to, level = "account" } = body;
  if (!account_db_id) return jsonResponse({ error: "account_db_id is required" }, 400);

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

  async function markTokenExpired(bmId: string): Promise<void> {
    await supabaseAdmin
      .from("meta_business_managers")
      .update({ status: "expired", updated_at: new Date().toISOString() })
      .eq("id", bmId);
    console.log(`Marked business manager ${bmId} as expired (Meta error 190)`);
  }

  const { data: member } = await supabaseAdmin
    .from("organization_members")
    .select("id")
    .eq("organization_id", account.organization_id)
    .eq("user_id", user.id)
    .not("accepted_at", "is", null)
    .single();

  if (!member) return jsonResponse({ error: "Forbidden" }, 403);

  const META_DATE_PRESETS: Record<string, string> = {
    today: "today", yesterday: "yesterday", last_7_days: "last_7_days",
    last_30_days: "last_30_days", this_month: "this_month", last_month: "last_month",
    this_quarter: "this_quarter", last_quarter: "last_quarter", this_year: "this_year",
  };

  const dateParams: Record<string, string> =
    period === "custom" && custom_from && custom_to
      ? { time_range: JSON.stringify({ since: custom_from, until: custom_to }) }
      : { date_preset: META_DATE_PRESETS[period] ?? "today" };

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
      if (body.error.code === 190 || body.error.type === "OAuthException") {
        throw Object.assign(new Error("TOKEN_EXPIRED"), { isTokenExpired: true });
      }
      throw new Error(body.error.message ?? "Meta API error");
    }
    return body;
  }

  const actionMaps = (row: Record<string, unknown>) => {
    const acts: Record<string, string> = {};
    for (const a of (row.actions as {action_type:string;value:string}[]) ?? []) acts[a.action_type] = a.value;
    const cpa: Record<string, string> = {};
    for (const a of (row.cost_per_action_type as {action_type:string;value:string}[]) ?? []) cpa[a.action_type] = a.value;
    return { acts, cpa };
  };

  // ── level = "campaign" ─────────────────────────────────────────
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
      const { acts, cpa } = actionMaps(c);
      const picked = pickResult(c, acts, cpa);
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
        results:          picked.results,
        cost_per_result:  picked.cost_per_result,
        result_basis:     picked.result_basis,
        messages:         acts[MSG_KEY] ?? null,
        cost_per_message: cpa[MSG_KEY]  ?? null,
        "actions:link_click":       acts["link_click"] ?? null,
        "actions:page_engagement":  acts["page_engagement"] ?? null,
        "cost_per_action_type:link_click": cpa["link_click"] ?? null,
      };
    });

    return jsonResponse({ campaigns, currency: account.currency });
  }

  // ── level = "daily" ───────────────────────────────────────────
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

  // ── level = "platform" ───────────────────────────────────────
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
      const { acts, cpa } = actionMaps(p);
      const picked = pickResult(p, acts, cpa);
      return {
        platform:        p.publisher_platform as string,
        spend:           p.spend,
        impressions:     p.impressions,
        reach:           p.reach,
        clicks:          p.clicks,
        results:         picked.results,
        cost_per_result: picked.cost_per_result,
        result_basis:    picked.result_basis,
      };
    }).sort((a, b) => parseFloat(String(b.spend ?? 0)) - parseFloat(String(a.spend ?? 0)));
    return jsonResponse({ platforms, currency: account.currency });
  }

  // ── level = "region" ─────────────────────────────────────────
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
      const { acts, cpa } = actionMaps(r);
      const picked = pickResult(r, acts, cpa);
      return {
        region:          r.region as string,
        spend:           r.spend,
        impressions:     r.impressions,
        results:         picked.results,
        cost_per_result: picked.cost_per_result,
        result_basis:    picked.result_basis,
      };
    }).sort((a, b) => parseFloat(String(b.spend ?? 0)) - parseFloat(String(a.spend ?? 0)));
    return jsonResponse({ regions, currency: account.currency });
  }

  // ── level = "ad" ───────────────────────────────────────────
  // Deliberately does NOT request results/cost_per_result: asking for them at
  // this level makes Meta return every ad in the account, including ones with
  // no delivery, which pushed the ads that actually spent past the row limit
  // and emptied the Best Creatives card. The priority list above supplies the
  // result instead.
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
      const { acts, cpa } = actionMaps(a);
      const picked = pickResult(a, acts, cpa);
      return {
        ad_id:           a.ad_id as string,
        ad_name:         a.ad_name as string,
        spend:           a.spend,
        impressions:     a.impressions,
        clicks:          a.clicks,
        results:         picked.results,
        cost_per_result: picked.cost_per_result,
        result_basis:    picked.result_basis,
      };
    });
    return jsonResponse({ ads, currency: account.currency });
  }

  // ── level = "billing" ───────────────────────────────────────
  if (level === "billing") {
    const BILLING_EVENTS = new Set([
      "ad_account_billing_charge",
      "ad_account_billing_charge_failed",
      "ad_account_billing_refund",
      "ad_account_billing_chargeback",
      "ad_account_billing_chargeback_reversal",
      "funding_event_successful",
      "funding_event_initiated",
      "ad_account_add_funding_source",
      "ad_account_remove_funding_source",
    ]);
    const sinceDate = new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10);
    const txs: Record<string, unknown>[] = [];
    let url: string | null = `${META_API}/act_${account.meta_account_id}/activities?fields=event_type,translated_event_type,event_time,extra_data&since=${sinceDate}&limit=500&access_token=${accessToken}`;
    try {
      for (let page = 0; page < 4 && url; page++) {
        const res = await fetch(url);
        const body = await res.json();
        if (body.error) {
          if (body.error.code === 190 || body.error.type === "OAuthException") {
            if (bm?.id) await markTokenExpired(bm.id);
            return jsonResponse({ error: "TOKEN_EXPIRED" }, 401);
          }
          return jsonResponse({ error: body.error.message ?? "Meta API error" }, 422);
        }
        for (const e of (body.data ?? []) as { event_type: string; translated_event_type: string; event_time: string; extra_data?: string }[]) {
          if (!BILLING_EVENTS.has(e.event_type)) continue;
          let x: Record<string, unknown> = {};
          try { x = JSON.parse(e.extra_data ?? "{}"); } catch { /* ignore */ }
          const cents = (x.new_value ?? x.amount) as number | undefined;
          txs.push({
            date: e.event_time,
            event_type: e.event_type,
            label: e.translated_event_type,
            amount: cents != null ? cents / 100 : null,
            currency: (x.currency as string) ?? account.currency ?? null,
            fee: x.fee != null ? (x.fee as number) / 100 : null,
            network: (x.network_id as string) ?? null,
            transaction_id: (x.transaction_id as string) ?? null,
          });
        }
        url = (body.paging?.next as string) ?? null;
      }
    } catch (e) {
      console.error("Billing activities fetch failed:", e);
      return jsonResponse({ error: "Meta API unreachable" }, 502);
    }
    return jsonResponse({ transactions: txs, currency: account.currency });
  }

  // ── level = "account" (default) ────────────────────────────────
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

  const accountBalance = balanceBody.balance != null
    ? parseFloat(balanceBody.balance) / 100
    : null;
  const spendCap = balanceBody.spend_cap != null && parseFloat(balanceBody.spend_cap) > 0
    ? parseFloat(balanceBody.spend_cap) / 100
    : null;

  const totalDailyBudgetCents = ((campaignsBody.data ?? []) as { daily_budget?: string }[])
    .filter(c => c.daily_budget && parseInt(c.daily_budget) > 0)
    .reduce((sum, c) => sum + parseInt(c.daily_budget!), 0);
  const totalDailyBudget = totalDailyBudgetCents > 0 ? totalDailyBudgetCents / 100 : null;

  if (metaBody.error) {
    console.error("Meta API error:", metaBody.error);
    if (metaBody.error.code === 190 || metaBody.error.type === "OAuthException") {
      if (bm?.id) await markTokenExpired(bm.id);
      return jsonResponse({ error: "TOKEN_EXPIRED" }, 401);
    }
    return jsonResponse({ error: metaBody.error.message ?? "Meta API error" }, 422);
  }

  const insight = metaBody.data?.[0] ?? {};

  const actions: Record<string, string> = {};
  for (const a of insight.actions ?? []) actions[a.action_type] = a.value;

  const costPerAction: Record<string, string> = {};
  for (const a of insight.cost_per_action_type ?? []) costPerAction[a.action_type] = a.value;

  const accountPicked = pickResult(insight, actions, costPerAction);

  // Awareness-side metrics, for the proposal benchmarks.
  const videoViews    = firstOf(actions, VIDEO_VIEW_KEYS);
  const profileVisits = firstOf(actions, PROFILE_VISIT_KEYS);
  const follows       = firstOf(actions, FOLLOW_KEYS);

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
      default:             return { since: today, until: today };
    }
  }

  let pageMessages: number | null = null;
  let messageSource: "business_suite" | "meta_ads" | null = null;
  const _debugPageInsights: Record<string, unknown> = {};

  const skipPageInsights = (period === "today");
  if (skipPageInsights) {
    console.log("Skipping page insights for 'today' period (24-48h delay on this metric)");
  }

  try {
    const META_APP_ID     = Deno.env.get("META_APP_ID");
    const META_APP_SECRET = Deno.env.get("META_APP_SECRET");
    const appToken = (META_APP_ID && META_APP_SECRET) ? `${META_APP_ID}|${META_APP_SECRET}` : null;
    console.log("App token available:", !!appToken);

    const fetchPageInsights = async (pageId: string): Promise<number | null> => {
      const { since, until } = periodToDates(period, custom_from, custom_to);
      _debugPageInsights.pageId = pageId;
      _debugPageInsights.since  = since;
      _debugPageInsights.until  = until;

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
      const storedPageId = (account as any).facebook_page_id as string | undefined;
      if (storedPageId) {
        console.log("Using stored page ID:", storedPageId);
        pageMessages = await fetchPageInsights(storedPageId);
        if (pageMessages !== null) messageSource = "business_suite";
        console.log("pageMessages via stored page ID:", pageMessages);
      }

      if (pageMessages === null) {
      const bizRes  = await fetch(`${META_API}/act_${account.meta_account_id}?fields=business&access_token=${accessToken}`);
      const bizData = await bizRes.json();
      const businessId = bizData.business?.id as string | undefined;
      console.log("BM ID:", businessId ?? "none");

      if (businessId) {
        const lookupToken = appToken ?? accessToken;

        const ownedRes  = await fetch(`${META_API}/${businessId}/owned_pages?fields=id,name&limit=10&access_token=${lookupToken}`);
        const ownedData = await ownedRes.json();
        let pageId = ownedData.data?.[0]?.id as string | undefined;
        console.log("owned_pages:", ownedData.data?.length ?? 0, "| error:", ownedData.error?.message ?? "none");

        if (!pageId) {
          const clientRes  = await fetch(`${META_API}/${businessId}/client_pages?fields=id,name&limit=10&access_token=${lookupToken}`);
          const clientData = await clientRes.json();
          pageId = clientData.data?.[0]?.id as string | undefined;
          console.log("client_pages:", clientData.data?.length ?? 0, "| error:", clientData.error?.message ?? "none");
        }

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
      }
    }
  } catch (e) {
    console.log("Page messages fetch failed:", e);
  }

  if (messageSource === null) {
    messageSource = actions["onsite_conversion.messaging_conversation_started_7d"] != null ? "meta_ads" : null;
  }

  const adSpend = parseFloat(insight.spend ?? "0") || 0;
  return jsonResponse({
    ad_entity: {
      id: `act_${account.meta_account_id}`,
      name: insight.account_name ?? account.account_name ?? account.meta_account_id,
      date_start: insight.date_start,
      date_stop: insight.date_stop,

      account_balance:  accountBalance,
      spend_cap:        spendCap,
      daily_budget:     totalDailyBudget,
      account_currency: balanceBody.currency ?? account.currency ?? null,
      funding_source:   balanceBody.funding_source_details?.display_string ?? null,
      lifetime_spent:   balanceBody.amount_spent != null ? parseFloat(balanceBody.amount_spent) / 100 : null,

      amount_spent: insight.spend,

      impressions: insight.impressions,
      reach: insight.reach,
      clicks: insight.clicks,
      cpm: insight.cpm,
      cpc: insight.cpc,
      ctr: insight.ctr,
      frequency: insight.frequency,

      results:          accountPicked.results,
      cost_per_result:  accountPicked.cost_per_result,
      result_basis:     accountPicked.result_basis,

      page_messages:    pageMessages,
      messages:         actions["onsite_conversion.messaging_conversation_started_7d"] ?? null,
      message_source:   messageSource,
      cost_per_message: pageMessages && adSpend ? String(adSpend / pageMessages) : (costPerAction["onsite_conversion.messaging_conversation_started_7d"] ?? null),

      "actions:like":             actions["like"]            ?? null,
      "actions:page_engagement":  actions["page_engagement"] ?? null,
      "actions:comment":          actions["comment"]         ?? null,
      "actions:post_reaction":    actions["post_reaction"]   ?? null,
      "actions:link_click":       actions["link_click"]      ?? insight.inline_link_clicks ?? null,

      // Awareness-side metrics. Each carries the action type it was read from,
      // because Meta's naming varies by placement and API version — a null with
      // no basis means nothing of that kind was tracked, not that it was zero.
      "actions:video_view":    videoViews.value,
      "actions:profile_visit": profileVisits.value,
      "actions:follow":        follows.value,
      video_view_basis:    videoViews.basis,
      profile_visit_basis: profileVisits.basis,
      follow_basis:        follows.basis,

      "cost_per_action_type:page_engagement": costPerAction["page_engagement"] ?? null,
      "cost_per_action_type:like":            costPerAction["like"] ?? null,
      "cost_per_action_type:omni_purchase":   costPerAction["omni_purchase"] ?? costPerAction["offsite_conversion.fb_pixel_purchase"] ?? null,
      "actions:omni_purchase":               actions["omni_purchase"] ?? actions["offsite_conversion.fb_pixel_purchase"] ?? null,
    },
    // Every action type Meta returned, so a metric missing above can be
    // identified from real data rather than guessed at.
    actions_all: actions,
    currency: account.currency,
    _debug_page_insights: _debugPageInsights,
  });
});
