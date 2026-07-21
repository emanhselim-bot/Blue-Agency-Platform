/**
 * TikTok Ads Data — Supabase Edge Function
 * Queries the TikTok Marketing API for campaign metrics.
 *
 * Metrics returned: spend, impressions, reach, clicks, ctr, conversions, conversion_value, roas
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

// ── TikTok API helpers ────────────────────────────────────────────────────────
const TIKTOK_API = "https://business-api.tiktok.com/open_api/v1.3";

interface TikTokMetrics {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  ctr: number;
  conversions: number;
  conversion_value: number;
  roas: number;
}

async function fetchTikTokMetrics(
  advertiserId: string,
  accessToken: string,
  startDate: string,
  endDate: string
): Promise<TikTokMetrics> {
  const params = new URLSearchParams({
    advertiser_id: advertiserId,
    report_type: "BASIC",
    dimensions: JSON.stringify(["stat_time_day"]),
    metrics: JSON.stringify([
      "spend", "impressions", "reach", "clicks", "ctr",
      "conversion", "value", "complete_payment_roas",
    ]),
    start_date: startDate,
    end_date:   endDate,
    page_size:  "1000",
  });

  const res = await fetch(`${TIKTOK_API}/report/integrated/get/?${params}`, {
    headers: {
      "Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const text = await res.text();
    console.warn("[tiktok-ads-data] HTTP error:", res.status, text.slice(0, 400));
    throw new Error(`TikTok API ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  console.log("[tiktok-ads-data] response code:", json.code, "message:", json.message);

  if (json.code !== 0) {
    throw new Error(`TikTok API error ${json.code}: ${json.message}`);
  }

  const rows: unknown[] = json?.data?.list ?? [];

  let totalSpend = 0, totalImpressions = 0, totalReach = 0, totalClicks = 0;
  let totalConversions = 0, totalConversionValue = 0;

  for (const row of rows) {
    const m = (row as { metrics?: Record<string, string | number> }).metrics ?? {};
    totalSpend            += parseFloat(String(m.spend ?? 0));
    totalImpressions      += parseInt(String(m.impressions ?? 0));
    totalReach            += parseInt(String(m.reach ?? 0));
    totalClicks           += parseInt(String(m.clicks ?? 0));
    totalConversions      += parseFloat(String(m.conversion ?? 0));
    totalConversionValue  += parseFloat(String(m.value ?? 0));
  }

  const ctr  = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
  const roas = totalSpend > 0 ? totalConversionValue / totalSpend : 0;

  return {
    spend:            parseFloat(totalSpend.toFixed(2)),
    impressions:      totalImpressions,
    reach:            totalReach,
    clicks:           totalClicks,
    ctr:              parseFloat(ctr.toFixed(2)),
    conversions:      parseFloat(totalConversions.toFixed(2)),
    conversion_value: parseFloat(totalConversionValue.toFixed(2)),
    roas:             parseFloat(roas.toFixed(2)),
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

async function fetchTikTokCampaigns(
  advertiserId: string,
  accessToken: string,
  startDate: string,
  endDate: string
): Promise<TikTokCampaign[]> {
  const params = new URLSearchParams({
    advertiser_id: advertiserId,
    report_type: "BASIC",
    dimensions: JSON.stringify(["campaign_id", "campaign_name"]),
    metrics: JSON.stringify([
      "campaign_name", "spend", "impressions", "clicks", "ctr",
      "conversion", "value", "complete_payment_roas",
    ]),
    start_date: startDate,
    end_date:   endDate,
    page_size:  "10",
  });

  const res = await fetch(`${TIKTOK_API}/report/integrated/get/?${params}`, {
    headers: { "Access-Token": accessToken, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) return [];
  const json = await res.json();
  if (json.code !== 0) return [];

  const rows: unknown[] = json?.data?.list ?? [];

  return rows.map(row => {
    const r = row as { dimensions?: Record<string, string>; metrics?: Record<string, string | number> };
    const m = r.metrics ?? {};
    const spend = parseFloat(String(m.spend ?? 0));
    const impressions = parseInt(String(m.impressions ?? 0));
    const clicks = parseInt(String(m.clicks ?? 0));
    return {
      name:        r.dimensions?.campaign_name ?? String(m.campaign_name ?? "Unknown"),
      spend:       parseFloat(spend.toFixed(2)),
      impressions,
      clicks,
      ctr:         impressions > 0 ? parseFloat(((clicks / impressions) * 100).toFixed(2)) : 0,
      conversions: parseFloat(String(m.conversion ?? 0)),
      roas:        spend > 0 ? parseFloat((parseFloat(String(m.value ?? 0)) / spend).toFixed(2)) : 0,
    };
  }).sort((a, b) => b.spend - a.spend).slice(0, 10);
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Unauthorized" }, 401);

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(
    authHeader.replace("Bearer ", "")
  );
  if (authError || !user) return jsonResponse({ error: "Unauthorized" }, 401);

  let body: { account_id?: string; organization_id?: string; since?: string; until?: string; include_campaigns?: boolean };
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "Invalid JSON" }, 400); }

  const { account_id, organization_id, since = "last_30_days", until = "last_30_days", include_campaigns = false } = body;

  if (!organization_id) return jsonResponse({ error: "organization_id required" }, 400);

  // Verify org membership
  const { data: member } = await supabaseAdmin
    .from("organization_members")
    .select("id")
    .eq("organization_id", organization_id)
    .eq("user_id", user.id)
    .not("accepted_at", "is", null)
    .single();
  if (!member) return jsonResponse({ error: "Forbidden" }, 403);

  // Fetch account(s)
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
  console.log(`[tiktok-ads-data] date range: ${start} → ${end}`);

  const results = await Promise.all(accounts.map(async (acct) => {
    try {
      const [metrics, campaigns] = await Promise.all([
        fetchTikTokMetrics(acct.advertiser_id, acct.access_token, start, end),
        include_campaigns
          ? fetchTikTokCampaigns(acct.advertiser_id, acct.access_token, start, end)
          : Promise.resolve([]),
      ]);
      return { account_id: acct.id, account_name: acct.account_name ?? acct.advertiser_id, metrics, campaigns };
    } catch (e) {
      console.error("[tiktok-ads-data] error for account", acct.id, (e as Error).message);
      return { account_id: acct.id, account_name: acct.account_name ?? acct.advertiser_id, error: (e as Error).message };
    }
  }));

  // Aggregate totals
  const totals: TikTokMetrics = { spend: 0, impressions: 0, reach: 0, clicks: 0, ctr: 0, conversions: 0, conversion_value: 0, roas: 0 };
  for (const r of results) {
    if (r.metrics) {
      totals.spend            += r.metrics.spend;
      totals.impressions      += r.metrics.impressions;
      totals.reach            += r.metrics.reach;
      totals.clicks           += r.metrics.clicks;
      totals.conversions      += r.metrics.conversions;
      totals.conversion_value += r.metrics.conversion_value;
    }
  }
  if (totals.impressions > 0) totals.ctr  = parseFloat(((totals.clicks / totals.impressions) * 100).toFixed(2));
  if (totals.spend > 0)       totals.roas = parseFloat((totals.conversion_value / totals.spend).toFixed(2));

  return jsonResponse({ totals, accounts: results, date_range: { start, end } });
});
