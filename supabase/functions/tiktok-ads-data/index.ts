/**
 * TikTok Ads Data — Supabase Edge Function
 *
 * Queries the TikTok Marketing API for an advertiser's metrics, and
 * optionally the campaigns behind them.
 *
 * This had never worked. It asked TikTok for a metric called `value` and
 * passed `campaign_name` as a dimension, and TikTok rejects both outright:
 *
 *   code 40002  Invalid metric fields: ['value']
 *   code 40002  Invalid value for dimensions: campaign_name is not supported
 *
 * Neither call could ever return anything, so the TikTok tab would have shown
 * an error the moment anyone pasted real credentials into Settings. Both were
 * confirmed against the live API before this rewrite, and the replacements
 * confirmed the same way against Cytarose's account.
 *
 * Conversion value: TikTok has no single "value" metric. Which one carries the
 * money depends on where the conversion happened -- a TikTok Shop purchase, an
 * on-site shopping event, or a web order -- so all three are requested and the
 * first that reports anything is used.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

// ── Date helpers ──────────────────────────────────────────────────────────────
function resolveDateRange(since: string, until: string): { start: string; end: string } {
  const now = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const nDaysAgo = (n: number) => { const d = new Date(now); d.setDate(d.getDate() - n); return fmt(d); };
  const firstOfMonth = (offset = 0) => fmt(new Date(now.getFullYear(), now.getMonth() + offset, 1));
  const lastOfMonth  = (offset = 0) => fmt(new Date(now.getFullYear(), now.getMonth() + 1 + offset, 0));
  const firstOfQuarter = (offset = 0) => {
    const q = Math.floor(now.getMonth() / 3) + offset;
    const year = now.getFullYear() + Math.floor(q / 4);
    const month = ((q % 4) + 4) % 4 * 3;
    return fmt(new Date(year, month, 1));
  };
  const lastOfQuarter = (offset = 0) => {
    const q = Math.floor(now.getMonth() / 3) + offset + 1;
    const year = now.getFullYear() + Math.floor(q / 4);
    const month = ((q % 4) + 4) % 4 * 3;
    return fmt(new Date(year, month, 0));
  };
  const resolve = (token: string, isEnd: boolean): string => {
    switch (token) {
      case "today":         return fmt(now);
      case "yesterday":     return fmt(yesterday);
      case "last_7_days":   return isEnd ? fmt(yesterday) : nDaysAgo(7);
      case "last_30_days":  return isEnd ? fmt(yesterday) : nDaysAgo(30);
      case "last_90_days":  return isEnd ? fmt(yesterday) : nDaysAgo(90);
      case "last_365_days": return isEnd ? fmt(yesterday) : nDaysAgo(365);
      case "this_week": {
        const day = now.getDay();
        const mon = new Date(now); mon.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
        return isEnd ? fmt(now) : fmt(mon);
      }
      case "this_month":   return isEnd ? fmt(now) : firstOfMonth();
      case "last_month":   return isEnd ? lastOfMonth(-1) : firstOfMonth(-1);
      case "this_quarter": return isEnd ? fmt(now) : firstOfQuarter();
      case "last_quarter": return isEnd ? lastOfQuarter(-1) : firstOfQuarter(-1);
      case "this_year":    return isEnd ? fmt(now) : `${now.getFullYear()}-01-01`;
      case "last_year":    return isEnd ? `${now.getFullYear() - 1}-12-31` : `${now.getFullYear() - 1}-01-01`;
      default:             return token;
    }
  };
  return { start: resolve(since, false), end: resolve(until, true) };
}

// ── TikTok API ────────────────────────────────────────────────────────────────
const TIKTOK_API = "https://business-api.tiktok.com/open_api/v1.3";

const num = (v: unknown) => {
  const n = parseFloat(String(v ?? ""));
  return isFinite(n) ? n : 0;
};

/** The three places TikTok can report conversion money, most specific first. */
const VALUE_METRICS = [
  "total_purchase_value",
  "total_onsite_shopping_value",
  "total_on_web_order_value",
] as const;

interface TikTokMetrics {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  ctr: number;
  conversions: number;
  conversion_value: number;
  roas: number;
  video_views: number;
  video_completions: number;
}

async function callReport(
  accessToken: string, params: URLSearchParams,
): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${TIKTOK_API}/report/integrated/get/?${params}`, {
    headers: { "Access-Token": accessToken, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TikTok API ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  if (json.code !== 0) {
    // TikTok's own message names the offending field, which is the only thing
    // that makes a 40002 fixable. Passing it through rather than flattening it
    // to "TikTok error" is what would have surfaced the `value` bug years ago.
    throw new Error(`TikTok API error ${json.code}: ${json.message}`);
  }
  return (json?.data?.list ?? []) as Record<string, unknown>[];
}

/**
 * Totals for the range.
 *
 * Deliberately queried without a day dimension. Reach is people, not events:
 * asking day by day and adding the results counts somebody once for every day
 * they saw an ad, which can overstate reach several times over on a long
 * range. One call over the whole range returns TikTok's deduplicated figure.
 */
async function fetchTikTokMetrics(
  advertiserId: string, accessToken: string, startDate: string, endDate: string,
): Promise<TikTokMetrics> {
  const params = new URLSearchParams({
    advertiser_id: advertiserId,
    report_type: "BASIC",
    data_level: "AUCTION_ADVERTISER",
    dimensions: JSON.stringify(["advertiser_id"]),
    metrics: JSON.stringify([
      "spend", "impressions", "reach", "clicks", "ctr",
      "conversion", "complete_payment_roas",
      "video_play_actions", "video_views_p100",
      ...VALUE_METRICS,
    ]),
    start_date: startDate,
    end_date:   endDate,
    page_size:  "100",
  });

  const rows = await callReport(accessToken, params);

  let spend = 0, impressions = 0, reach = 0, clicks = 0;
  let conversions = 0, conversionValue = 0, videoViews = 0, videoCompletions = 0;

  for (const row of rows) {
    const m = (row.metrics ?? {}) as Record<string, unknown>;
    spend       += num(m.spend);
    impressions += num(m.impressions);
    reach       += num(m.reach);
    clicks      += num(m.clicks);
    conversions += num(m.conversion);
    videoViews       += num(m.video_play_actions);
    videoCompletions += num(m.video_views_p100);
    // First of the three that reports anything wins; they measure the same
    // money through different funnels and adding them would double-count.
    for (const k of VALUE_METRICS) {
      const v = num(m[k]);
      if (v > 0) { conversionValue += v; break; }
    }
  }

  const ctr  = impressions > 0 ? (clicks / impressions) * 100 : 0;
  const roas = spend > 0 ? conversionValue / spend : 0;

  return {
    spend:             parseFloat(spend.toFixed(2)),
    impressions,
    reach,
    clicks,
    ctr:               parseFloat(ctr.toFixed(2)),
    conversions:       parseFloat(conversions.toFixed(2)),
    conversion_value:  parseFloat(conversionValue.toFixed(2)),
    roas:              parseFloat(roas.toFixed(2)),
    video_views:       videoViews,
    video_completions: videoCompletions,
  };
}

// ── Campaign breakdown ────────────────────────────────────────────────────────
interface TikTokCampaign {
  name: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  conversions: number;
  roas: number;
}

/**
 * Campaigns behind the totals.
 *
 * campaign_name is requested as a metric, not a dimension. TikTok rejects it
 * as a dimension outright -- which is what the previous version did, so this
 * breakdown never returned a single row.
 */
async function fetchTikTokCampaigns(
  advertiserId: string, accessToken: string, startDate: string, endDate: string,
): Promise<TikTokCampaign[]> {
  const params = new URLSearchParams({
    advertiser_id: advertiserId,
    report_type: "BASIC",
    data_level: "AUCTION_CAMPAIGN",
    dimensions: JSON.stringify(["campaign_id"]),
    metrics: JSON.stringify([
      "campaign_name", "spend", "impressions", "clicks", "ctr",
      "conversion", "complete_payment_roas", ...VALUE_METRICS,
    ]),
    start_date: startDate,
    end_date:   endDate,
    page_size:  "100",
  });

  // A broken breakdown must not take the totals down with it: the tab is still
  // worth showing without its campaign list.
  let rows: Record<string, unknown>[] = [];
  try { rows = await callReport(accessToken, params); }
  catch (e) { console.warn("[tiktok-ads-data] campaigns:", (e as Error).message); return []; }

  return rows.map(row => {
    const m = (row.metrics ?? {}) as Record<string, unknown>;
    const spend = num(m.spend);
    const impressions = num(m.impressions);
    const clicks = num(m.clicks);
    let value = 0;
    for (const k of VALUE_METRICS) { const v = num(m[k]); if (v > 0) { value = v; break; } }
    return {
      name:        String(m.campaign_name ?? "Unknown"),
      spend:       parseFloat(spend.toFixed(2)),
      impressions,
      clicks,
      ctr:         impressions > 0 ? parseFloat(((clicks / impressions) * 100).toFixed(2)) : 0,
      conversions: num(m.conversion),
      roas:        spend > 0 ? parseFloat((value / spend).toFixed(2)) : 0,
    };
  }).sort((a, b) => b.spend - a.spend).slice(0, 10);
}

// ── Handler ───────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Unauthorized" }, 401);

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(
    authHeader.replace("Bearer ", ""),
  );
  if (authError || !user) return jsonResponse({ error: "Unauthorized" }, 401);

  let body: {
    account_id?: string; organization_id?: string;
    since?: string; until?: string; include_campaigns?: boolean;
  };
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "Invalid JSON" }, 400); }

  const {
    account_id, organization_id,
    since = "last_30_days", until = "last_30_days",
    include_campaigns = false,
  } = body;

  if (!organization_id) return jsonResponse({ error: "organization_id required" }, 400);

  // Membership of the organization. Holding a valid login is not by itself
  // permission to read a client's figures.
  const { data: member } = await supabaseAdmin
    .from("organization_members")
    .select("id")
    .eq("organization_id", organization_id)
    .eq("user_id", user.id)
    .not("accepted_at", "is", null)
    .maybeSingle();
  if (!member) return jsonResponse({ error: "Forbidden" }, 403);

  let query = supabaseAdmin
    .from("tiktok_ads_accounts")
    .select("*")
    .eq("organization_id", organization_id)
    .eq("is_active", true);

  if (account_id) query = query.eq("id", account_id);

  const { data: accounts, error: acctErr } = await query;
  if (acctErr || !accounts?.length) {
    return jsonResponse({ error: "No TikTok Ads accounts found" }, 404);
  }

  const { start, end } = resolveDateRange(since, until);

  type Result = {
    account_id: string; account_name: string;
    metrics?: TikTokMetrics; campaigns?: TikTokCampaign[]; error?: string;
  };

  // deno-lint-ignore no-explicit-any
  const results: Result[] = await Promise.all(accounts.map(async (acct: any) => {
    try {
      const [metrics, campaigns] = await Promise.all([
        fetchTikTokMetrics(acct.advertiser_id, acct.access_token, start, end),
        include_campaigns
          ? fetchTikTokCampaigns(acct.advertiser_id, acct.access_token, start, end)
          : Promise.resolve([]),
      ]);
      return {
        account_id: acct.id,
        account_name: acct.account_name ?? acct.advertiser_id,
        metrics, campaigns,
      };
    } catch (e) {
      // One account's bad token must not blank the others.
      console.error("[tiktok-ads-data]", acct.id, (e as Error).message);
      return {
        account_id: acct.id,
        account_name: acct.account_name ?? acct.advertiser_id,
        error: (e as Error).message,
      };
    }
  }));

  const totals: TikTokMetrics = {
    spend: 0, impressions: 0, reach: 0, clicks: 0, ctr: 0,
    conversions: 0, conversion_value: 0, roas: 0,
    video_views: 0, video_completions: 0,
  };
  for (const r of results) {
    if (!r.metrics) continue;
    totals.spend             += r.metrics.spend;
    totals.impressions       += r.metrics.impressions;
    totals.reach             += r.metrics.reach;
    totals.clicks            += r.metrics.clicks;
    totals.conversions       += r.metrics.conversions;
    totals.conversion_value  += r.metrics.conversion_value;
    totals.video_views       += r.metrics.video_views;
    totals.video_completions += r.metrics.video_completions;
  }
  if (totals.impressions > 0) totals.ctr  = parseFloat(((totals.clicks / totals.impressions) * 100).toFixed(2));
  if (totals.spend > 0)       totals.roas = parseFloat((totals.conversion_value / totals.spend).toFixed(2));
  totals.spend = parseFloat(totals.spend.toFixed(2));
  totals.conversion_value = parseFloat(totals.conversion_value.toFixed(2));

  return jsonResponse({ totals, accounts: results, date_range: { start, end } });
});
