/**
 * clarity-data — Supabase Edge Function
 * Deploy: supabase functions deploy clarity-data
 *
 * Fetches Microsoft Clarity website analytics with 12-hour caching.
 * (Clarity Export API is limited to 10 requests/project/day)
 *
 * Required secret: CLARITY_API_TOKEN
 *   → Clarity dashboard → Settings → Data Export → Generate new API token
 *
 * API: GET https://www.clarity.ms/export-data/api/v1/project-live-insights
 *        ?numOfDays=3&dimension1=Device
 *   Authorization: Bearer {token}
 *
 * Returns:
 *   { sessions, pageViews, addToCart, checkout, removeFromCart, configured, _cached }
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

const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours

type MetricRow = Record<string, string | number>;

interface ClarityMetric {
  metricName: string;
  information?: MetricRow[];
}

// Find a metric by name (checks several aliases, case-insensitive)
function findMetric(metrics: ClarityMetric[], ...names: string[]): MetricRow[] | null {
  const lower = names.map(n => n.toLowerCase());
  const m = metrics.find(m => lower.includes((m.metricName ?? "").toLowerCase()));
  return m?.information ?? null;
}

// Sum a numeric field across rows; tries multiple field names.
function sumField(rows: MetricRow[], ...fields: string[]): number {
  return rows.reduce((total, row) => {
    for (const f of fields) {
      const v = row[f];
      if (v !== undefined && v !== null) {
        const n = parseInt(String(v), 10);
        if (!isNaN(n)) return total + n;
      }
    }
    return total;
  }, 0);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // 1. Auth
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Unauthorized" }, 401);

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(
    authHeader.replace("Bearer ", "")
  );
  if (authError || !user) return jsonResponse({ error: "Unauthorized" }, 401);

  // 1b. Parse body: numOfDays + orgId
  let numOfDays = 1;
  let orgId: string | null = null;
  try {
    const body = await req.json();
    if (body?.numOfDays && Number.isInteger(body.numOfDays) && body.numOfDays > 0) {
      numOfDays = Math.min(body.numOfDays, 90); // Clarity max is 90 days
    }
    if (body?.orgId && typeof body.orgId === "string") orgId = body.orgId;
  } catch { /* no body / not JSON — use default */ }

  const CACHE_KEY = orgId
    ? `clarity_metrics_v3_${orgId}_${numOfDays}d`
    : `clarity_metrics_v3_${numOfDays}d`;

  // 2. Check cache
  const { data: cached } = await supabaseAdmin
    .from("system_cache")
    .select("payload, updated_at")
    .eq("cache_key", CACHE_KEY)
    .single();

  if (cached) {
    const age = Date.now() - new Date(cached.updated_at).getTime();
    if (age < CACHE_TTL) {
      return jsonResponse({ ...cached.payload, _cached: true });
    }
  }

  // 3. Resolve Clarity API token: per-org first, then global env var fallback
  let token = Deno.env.get("CLARITY_API_TOKEN");
  if (orgId) {
    const { data: org } = await supabaseAdmin
      .from("organizations")
      .select("clarity_api_token")
      .eq("id", orgId)
      .single();
    if (org?.clarity_api_token) token = org.clarity_api_token;
  }

  if (!token) {
    return jsonResponse({
      sessions: null, pageViews: null,
      addToCart: null, checkout: null, removeFromCart: null,
      configured: false,
    });
  }

  try {
    const res = await fetch(
      `https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=${numOfDays}&dimension1=Device`,
      { headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" } }
    );

    if (!res.ok) {
      const text = await res.text();
      console.error(`Clarity API ${res.status}:`, text);
      if (cached) return jsonResponse({ ...cached.payload, _stale: true });
      return jsonResponse({
        sessions: null, pageViews: null,
        addToCart: null, checkout: null, removeFromCart: null,
        configured: true,
      });
    }

    const data = await res.json();
    const allMetrics: ClarityMetric[] = Array.isArray(data) ? data : [];

    // Log all returned metric names + Traffic row keys for debugging
    console.log("Clarity metric names:", allMetrics.map(m => m.metricName).join(", "));
    const trafficMetricObj = allMetrics.find(m => (m.metricName ?? "").toLowerCase() === "traffic");
    if (trafficMetricObj?.information?.[0]) {
      console.log("Traffic row keys:", Object.keys(trafficMetricObj.information[0]).join(", "));
      console.log("Traffic row[0]:", JSON.stringify(trafficMetricObj.information[0]));
    }

    // ── Traffic ──────────────────────────────────────────────────────────────
    const trafficRows = trafficMetricObj?.information ?? [];
    const totalSessions = sumField(trafficRows, "totalSessionCount");

    // Pages per session — try every possible field name Clarity might use
    const AVG_PAGE_FIELDS = [
      "PagesPerSessionPercentage", "pagesPerSession", "avgPages",
      "avgPageViews", "pageViewsPerSession", "pages",
    ];
    const avgPagesArr = trafficRows.map(r => {
      for (const f of AVG_PAGE_FIELDS) {
        const v = parseFloat(String(r[f] ?? ""));
        if (!isNaN(v) && v > 0) return v;
      }
      return 0;
    }).filter(v => v > 0);
    const avgPages = avgPagesArr.length > 0
      ? avgPagesArr.reduce((a, b) => a + b, 0) / avgPagesArr.length
      : 0;

    // ── Page Views ───────────────────────────────────────────────────────────
    // Try a dedicated metric first; fall back to sessions × avg pages per session
    const pvRows = findMetric(allMetrics,
      "PageViews", "Page Views", "Pageviews", "page_views",
      "Pages", "PopularPages", "Popular Pages");
    let pageViews: number | null = null;
    if (pvRows && pvRows.length > 0) {
      console.log("PV metric rows[0]:", JSON.stringify(pvRows[0]));
      const total = sumField(pvRows,
        "totalPageViewCount", "pageViewCount", "PageViews", "pageViews",
        "count", "totalCount", "totalSessionCount");
      if (total > 0) pageViews = total;
    }
    if (!pageViews && totalSessions > 0 && avgPages > 0) {
      pageViews = Math.round(totalSessions * avgPages);
    }

    // ── Smart Events (funnel) ─────────────────────────────────────────────────
    // Clarity automatically tracks e-commerce events; they may appear as separate
    // metric objects in the full API response per the docs:
    // "Additional metrics and dimensions may be included in the full API response."
    const EVENT_COUNT_FIELDS = [
      "count", "totalCount", "eventCount", "totalEventCount",
      "sessionCount", "totalSessionCount",
    ] as const;

    const atcRows = findMetric(allMetrics,
      "AddToCart", "Add To Cart", "add_to_cart", "addtocart", "Add to Cart");
    const addToCart = atcRows
      ? (sumField(atcRows, ...EVENT_COUNT_FIELDS) || null)
      : null;

    const coRows = findMetric(allMetrics,
      "Checkout", "BeginCheckout", "Begin Checkout", "begin_checkout", "begincheckout");
    const checkout = coRows
      ? (sumField(coRows, ...EVENT_COUNT_FIELDS) || null)
      : null;

    const rfcRows = findMetric(allMetrics,
      "RemoveFromCart", "Remove From Cart", "remove_from_cart", "removefromcart", "Remove from Cart");
    const removeFromCart = rfcRows
      ? (sumField(rfcRows, ...EVENT_COUNT_FIELDS) || null)
      : null;

    const payload = {
      sessions:       totalSessions > 0 ? totalSessions : null,
      pageViews,
      addToCart,
      checkout,
      removeFromCart,
      configured:     true,
    };

    // 4. Store in cache
    await supabaseAdmin.from("system_cache").upsert(
      { cache_key: CACHE_KEY, payload, updated_at: new Date().toISOString() },
      { onConflict: "cache_key" }
    );

    return jsonResponse({ ...payload, _cached: false });

  } catch (e) {
    console.error("clarity-data error:", e);
    if (cached) return jsonResponse({ ...cached.payload, _stale: true });
    return jsonResponse({
      sessions: null, pageViews: null,
      addToCart: null, checkout: null, removeFromCart: null,
      configured: true,
    });
  }
});
