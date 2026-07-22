/**
 * Google Ads Data — Supabase Edge Function
 * Queries the Google Ads API (REST) for campaign metrics.
 *
 * Metrics returned: spend, impressions, clicks, ctr, conversions, conversion_value, roas, cpc, cost_per_conversion
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

// ── Token refresh ─────────────────────────────────────────────────────────────
async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  return json.access_token as string;
}

// ── Date helpers ──────────────────────────────────────────────────────────────
function resolveDateRange(since: string, until: string): { start: string; end: string } {
  const now = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  const nDaysAgo = (n: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() - n);
    return fmt(d);
  };

  const firstOfMonth = (offset = 0) => {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    return fmt(d);
  };
  const lastOfMonth = (offset = 0) => {
    const d = new Date(now.getFullYear(), now.getMonth() + 1 + offset, 0);
    return fmt(d);
  };
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
      case "this_month":    return isEnd ? fmt(now) : firstOfMonth();
      case "last_month":    return isEnd ? lastOfMonth(-1) : firstOfMonth(-1);
      case "this_quarter":  return isEnd ? fmt(now) : firstOfQuarter();
      case "last_quarter":  return isEnd ? lastOfQuarter(-1) : firstOfQuarter(-1);
      case "this_year":     return isEnd ? fmt(now) : `${now.getFullYear()}-01-01`;
      case "last_year":     return isEnd ? `${now.getFullYear() - 1}-12-31` : `${now.getFullYear() - 1}-01-01`;
      default:              return token; // already YYYY-MM-DD
    }
  };

  return { start: resolve(since, false), end: resolve(until, true) };
}

// ── Google Ads API query ──────────────────────────────────────────────────────
interface GoogleAdsMetrics {
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  conversions: number;
  conversion_value: number;
  roas: number;
  cpc: number;
  cost_per_conversion: number;
}

async function fetchGoogleAdsMetrics(
  customerId: string,
  developerToken: string,
  accessToken: string,
  startDate: string,
  endDate: string
): Promise<GoogleAdsMetrics> {
  // Remove dashes from customer ID
  const cid = customerId.replace(/-/g, "");

  const gaql = `
    SELECT
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
      AND campaign.status != 'REMOVED'
  `;

  const res = await fetch(
    `https://googleads.googleapis.com/v24/customers/${cid}/googleAds:searchStream`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "developer-token": developerToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: gaql }),
      signal: AbortSignal.timeout(20_000),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    console.warn("[google-ads-data] API error:", res.status, text.slice(0, 500));
    throw new Error(`Google Ads API ${res.status}: ${text.slice(0, 200)}`);
  }

  // searchStream returns an array of result batches (NDJSON or JSON array)
  const text = await res.text();
  console.log("[google-ads-data] raw response snippet:", text.slice(0, 500));

  let batches: unknown[] = [];
  try {
    // May be a JSON array
    const parsed = JSON.parse(text);
    batches = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // NDJSON fallback
    batches = text.trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
  }

  let totalCostMicros = 0;
  let totalImpressions = 0;
  let totalClicks = 0;
  let totalConversions = 0;
  let totalConversionValue = 0;

  for (const batch of batches) {
    const results = (batch as { results?: unknown[] }).results ?? [];
    for (const row of results) {
      const m = (row as { metrics?: Record<string, number> }).metrics ?? {};
      totalCostMicros      += Number(m.costMicros      ?? m.cost_micros      ?? 0);
      totalImpressions     += Number(m.impressions      ?? 0);
      totalClicks          += Number(m.clicks           ?? 0);
      totalConversions     += Number(m.conversions      ?? 0);
      totalConversionValue += Number(m.conversionsValue ?? m.conversions_value ?? 0);
    }
  }

  const spend = totalCostMicros / 1_000_000;
  const ctr   = totalClicks > 0 && totalImpressions > 0
    ? (totalClicks / totalImpressions) * 100
    : 0;
  const roas  = spend > 0 ? totalConversionValue / spend : 0;
  const cpc   = totalClicks > 0 ? spend / totalClicks : 0;
  const cost_per_conversion = totalConversions > 0 ? spend / totalConversions : 0;

  return {
    spend:                parseFloat(spend.toFixed(2)),
    impressions:          totalImpressions,
    clicks:               totalClicks,
    ctr:                  parseFloat(ctr.toFixed(2)),
    conversions:          parseFloat(totalConversions.toFixed(2)),
    conversion_value:     parseFloat(totalConversionValue.toFixed(2)),
    roas:                 parseFloat(roas.toFixed(2)),
    cpc:                  parseFloat(cpc.toFixed(2)),
    cost_per_conversion:  parseFloat(cost_per_conversion.toFixed(2)),
  };
}

// ── Campaign breakdown ────────────────────────────────────────────────────────
interface CampaignRow {
  name: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  conversions: number;
  roas: number;
  cpc: number;
  cost_per_conversion: number;
}

async function fetchGoogleAdsCampaigns(
  customerId: string,
  developerToken: string,
  accessToken: string,
  startDate: string,
  endDate: string
): Promise<CampaignRow[]> {
  const cid = customerId.replace(/-/g, "");

  const gaql = `
    SELECT
      campaign.name,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
      AND campaign.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
    LIMIT 10
  `;

  const res = await fetch(
    `https://googleads.googleapis.com/v24/customers/${cid}/googleAds:searchStream`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "developer-token": developerToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: gaql }),
      signal: AbortSignal.timeout(20_000),
    }
  );

  if (!res.ok) return [];

  const text = await res.text();
  let batches: unknown[] = [];
  try {
    const parsed = JSON.parse(text);
    batches = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    batches = text.trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
  }

  const campaigns: CampaignRow[] = [];
  for (const batch of batches) {
    const results = (batch as { results?: unknown[] }).results ?? [];
    for (const row of results) {
      const r = row as { campaign?: { name?: string }; metrics?: Record<string, number> };
      const m = r.metrics ?? {};
      const costMicros = Number(m.costMicros ?? m.cost_micros ?? 0);
      const spend      = costMicros / 1_000_000;
      const clicks     = Number(m.clicks ?? 0);
      const impressions= Number(m.impressions ?? 0);
      const conversions= Number(m.conversions ?? 0);
      const convValue  = Number(m.conversionsValue ?? m.conversions_value ?? 0);
      campaigns.push({
        name:                r.campaign?.name ?? "Unknown",
        spend:               parseFloat(spend.toFixed(2)),
        impressions,
        clicks,
        ctr:                 impressions > 0 ? parseFloat(((clicks / impressions) * 100).toFixed(2)) : 0,
        conversions:         parseFloat(conversions.toFixed(2)),
        roas:                spend > 0 ? parseFloat((convValue / spend).toFixed(2)) : 0,
        cpc:                 clicks > 0 ? parseFloat((spend / clicks).toFixed(2)) : 0,
        cost_per_conversion: conversions > 0 ? parseFloat((spend / conversions).toFixed(2)) : 0,
      });
    }
  }

  return campaigns.sort((a, b) => b.spend - a.spend).slice(0, 10);
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
    .from("google_ads_accounts")
    .select("*")
    .eq("organization_id", organization_id)
    .eq("is_active", true);

  if (account_id) query = query.eq("id", account_id);

  const { data: accounts, error: acctErr } = await query;
  if (acctErr || !accounts?.length) {
    return jsonResponse({ error: "No Google Ads accounts found" }, 404);
  }

  const { start, end } = resolveDateRange(since, until);
  console.log(`[google-ads-data] date range: ${start} → ${end}`);

  // Fetch metrics for all accounts in parallel
  const results = await Promise.all(accounts.map(async (acct) => {
    try {
      const accessToken = await refreshAccessToken(
        acct.client_id, acct.client_secret, acct.refresh_token
      );
      const [metrics, campaigns] = await Promise.all([
        fetchGoogleAdsMetrics(acct.customer_id, acct.developer_token, accessToken, start, end),
        include_campaigns
          ? fetchGoogleAdsCampaigns(acct.customer_id, acct.developer_token, accessToken, start, end)
          : Promise.resolve([]),
      ]);
      return { account_id: acct.id, account_name: acct.account_name ?? acct.customer_id, metrics, campaigns };
    } catch (e) {
      console.error("[google-ads-data] error for account", acct.id, (e as Error).message);
      return { account_id: acct.id, account_name: acct.account_name ?? acct.customer_id, error: (e as Error).message };
    }
  }));

  // Aggregate totals across accounts
  const totals: GoogleAdsMetrics = { spend: 0, impressions: 0, clicks: 0, ctr: 0, conversions: 0, conversion_value: 0, roas: 0, cpc: 0, cost_per_conversion: 0 };
  for (const r of results) {
    if (r.metrics) {
      totals.spend            += r.metrics.spend;
      totals.impressions      += r.metrics.impressions;
      totals.clicks           += r.metrics.clicks;
      totals.conversions      += r.metrics.conversions;
      totals.conversion_value += r.metrics.conversion_value;
    }
  }
  if (totals.impressions > 0) totals.ctr                = parseFloat(((totals.clicks / totals.impressions) * 100).toFixed(2));
  if (totals.spend > 0)       totals.roas               = parseFloat((totals.conversion_value / totals.spend).toFixed(2));
  if (totals.clicks > 0)      totals.cpc                = parseFloat((totals.spend / totals.clicks).toFixed(2));
  if (totals.conversions > 0) totals.cost_per_conversion = parseFloat((totals.spend / totals.conversions).toFixed(2));

  return jsonResponse({ totals, accounts: results, date_range: { start, end } });
});
