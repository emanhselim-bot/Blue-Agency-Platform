/**
 * clarity-data — Supabase Edge Function
 * Deploy: supabase functions deploy clarity-data
 *
 * Supports multiple Clarity projects per org via the clarity_projects table.
 * Falls back to organizations.clarity_api_token for backward compatibility.
 *
 * Request body (all optional):
 *   orgId            — filter to this org
 *   numOfDays        — 1–90 (default 1, clamped to 3 for Clarity API)
 *   clarityProjectId — UUID from clarity_projects table; if omitted, fetches
 *                      ALL active projects for the org and merges results
 *
 * Returns:
 *   { sessions, pageViews, addToCart, checkout, removeFromCart,
 *     browsers, operatingSystems, channels, countries, topPages,
 *     configured, projects: [...], _cached }
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
interface ClarityMetric { metricName: string; information?: MetricRow[]; }

function findMetric(metrics: ClarityMetric[], ...names: string[]): MetricRow[] | null {
  const lower = names.map(n => n.toLowerCase());
  const m = metrics.find(m => lower.includes((m.metricName ?? "").toLowerCase()));
  return m?.information ?? null;
}

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

/** Aggregate rows by a dimension field into [{name, sessions}] sorted desc */
function aggregateByField(rows: MetricRow[], ...fieldNames: string[]): { name: string; sessions: number }[] {
  const map = new Map<string, number>();
  for (const row of rows) {
    let name: string | null = null;
    for (const f of fieldNames) {
      const v = row[f];
      if (v != null && v !== "") { name = String(v); break; }
    }
    if (!name) continue;
    const n = Number(row["totalSessionCount"] ?? row["totalCount"] ?? row["count"] ?? 0);
    if (n > 0) map.set(name, (map.get(name) ?? 0) + n);
  }
  return Array.from(map.entries())
    .map(([name, sessions]) => ({ name, sessions }))
    .sort((a, b) => b.sessions - a.sessions);
}

const EVENT_FIELDS = ["count","totalCount","eventCount","totalEventCount","sessionCount","totalSessionCount"] as const;

/** Parse Clarity NDJSON / JSON array response into metric list */
function parseClarityResponse(text: string): ClarityMetric[] {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    try {
      return text.trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
    } catch {
      return [];
    }
  }
}

async function fetchClarityProject(
  token: string,
  numOfDays: number,
  projectName: string
): Promise<{
  sessions: number | null;
  pageViews: number | null;
  addToCart: number | null;
  checkout: number | null;
  removeFromCart: number | null;
  browsers: { name: string; sessions: number }[];
  operatingSystems: { name: string; sessions: number }[];
  channels: { name: string; sessions: number }[];
  countries: { name: string; sessions: number }[];
  topPages: { url: string; sessions: number }[];
  projectName: string;
  ok: boolean;
}> {
  const empty = {
    sessions: null, pageViews: null, addToCart: null, checkout: null, removeFromCart: null,
    browsers: [], operatingSystems: [], channels: [], countries: [], topPages: [],
    projectName, ok: false,
  };

  // Clarity API only accepts 1, 2, or 3 for numOfDays
  const clarityDays = Math.min(Math.max(numOfDays, 1), 3);
  const base = `https://www.clarity.ms/export-data/api/v1/project-live-insights`;
  const hdrs = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };

  try {
    // Two parallel calls to cover all dimensions within the 10 req/day limit:
    // Call 1 (device): sessions, page views, funnel events + try Popular Pages & Country/Region
    // Call 2 (browser+OS+channel): browser breakdown, OS breakdown, traffic source/channel
    const [res1, res2] = await Promise.all([
      fetch(`${base}?numOfDays=${clarityDays}&dimension1=Device`, { headers: hdrs }),
      fetch(`${base}?numOfDays=${clarityDays}&dimension1=Browser&dimension2=OS&dimension3=Channel`, { headers: hdrs }),
    ]);

    // ── Parse Call 1 (Device dimension) ───────────────────────────────────────
    let sessions: number | null = null;
    let pageViews: number | null = null;
    let addToCart: number | null = null;
    let checkout: number | null = null;
    let removeFromCart: number | null = null;
    let countries: { name: string; sessions: number }[] = [];
    let topPages: { url: string; sessions: number }[] = [];

    if (res1.ok) {
      const allMetrics = parseClarityResponse(await res1.text());

      // Sessions
      const trafficRows = allMetrics.find(m => (m.metricName ?? "").toLowerCase() === "traffic")?.information ?? [];
      const totalSessions = sumField(trafficRows, "totalSessionCount");

      // Page Views (avg pages × sessions)
      const AVG_PAGE_FIELDS = ["PagesPerSessionPercentage","pagesPerSession","avgPages","avgPageViews","pageViewsPerSession","pages"];
      const avgPagesArr = trafficRows.map(r => {
        for (const f of AVG_PAGE_FIELDS) { const v = parseFloat(String(r[f] ?? "")); if (!isNaN(v) && v > 0) return v; }
        return 0;
      }).filter(v => v > 0);
      const avgPages = avgPagesArr.length > 0 ? avgPagesArr.reduce((a, b) => a + b, 0) / avgPagesArr.length : 0;

      const pvRows = findMetric(allMetrics, "PageViews","Page Views","Pageviews","page_views","Pages","PopularPages","Popular Pages");
      let pv: number | null = null;
      if (pvRows?.length) {
        const total = sumField(pvRows, "totalPageViewCount","pageViewCount","PageViews","pageViews","count","totalCount","totalSessionCount");
        if (total > 0) pv = total;
      }
      if (!pv && totalSessions > 0 && avgPages > 0) pv = Math.round(totalSessions * avgPages);

      // Funnel events
      const atcRows = findMetric(allMetrics, "AddToCart","Add To Cart","add_to_cart","addtocart","Add to Cart");
      const coRows  = findMetric(allMetrics, "Checkout","BeginCheckout","Begin Checkout","begin_checkout");
      const rfcRows = findMetric(allMetrics, "RemoveFromCart","Remove From Cart","remove_from_cart");

      sessions      = totalSessions > 0 ? totalSessions : null;
      pageViews     = pv;
      addToCart     = atcRows ? (sumField(atcRows, ...EVENT_FIELDS) || null) : null;
      checkout      = coRows  ? (sumField(coRows,  ...EVENT_FIELDS) || null) : null;
      removeFromCart= rfcRows ? (sumField(rfcRows, ...EVENT_FIELDS) || null) : null;

      // Countries — try Country/Region metric in the response
      const countryRows = findMetric(allMetrics, "Country/Region", "CountryRegion", "Country", "Region") ?? [];
      const countryAgg = aggregateByField(countryRows, "Country/Region", "CountryRegion", "Country", "Region");
      if (countryAgg.length > 0) countries = countryAgg.slice(0, 8);

      // Top Pages — try Popular Pages metric
      const popRows = findMetric(allMetrics, "Popular Pages", "PopularPages", "popular_pages", "URL", "Urls", "page_views") ?? [];
      const pageAgg = popRows
        .map(r => ({
          url: String(r["URL"] ?? r["url"] ?? r["Page"] ?? r["page"] ?? r["PageTitle"] ?? ""),
          sessions: Number(r["totalSessionCount"] ?? r["totalPageViewCount"] ?? r["count"] ?? 0),
        }))
        .filter(p => p.url && p.sessions > 0)
        .sort((a, b) => b.sessions - a.sessions)
        .slice(0, 8);
      if (pageAgg.length > 0) topPages = pageAgg;
    } else {
      console.error(`[clarity-data] Call 1 failed ${res1.status} for "${projectName}"`);
    }

    // ── Parse Call 2 (Browser+OS+Channel dimensions) ──────────────────────────
    let browsers: { name: string; sessions: number }[] = [];
    let operatingSystems: { name: string; sessions: number }[] = [];
    let channels: { name: string; sessions: number }[] = [];

    if (res2.ok) {
      const analytics = parseClarityResponse(await res2.text());
      const trafficRows2 = analytics.find(m => (m.metricName ?? "").toLowerCase() === "traffic")?.information ?? [];

      browsers         = aggregateByField(trafficRows2, "Browser").slice(0, 6);
      operatingSystems = aggregateByField(trafficRows2, "OS").slice(0, 6);
      channels         = aggregateByField(trafficRows2, "Channel", "Source", "Medium").slice(0, 6);

      // If countries not found in call 1, try from this response
      if (countries.length === 0) {
        const ctryRows2 = analytics.find(m =>
          ["country/region","countryregion","country","region"].includes((m.metricName ?? "").toLowerCase())
        )?.information ?? [];
        const c2 = aggregateByField(ctryRows2, "Country/Region", "CountryRegion", "Country");
        if (c2.length > 0) countries = c2.slice(0, 8);
      }

      // If top pages not found in call 1, try Popular Pages from call 2
      if (topPages.length === 0) {
        const popRows2 = analytics.find(m =>
          ["popular pages","popularpages","url","urls"].includes((m.metricName ?? "").toLowerCase())
        )?.information ?? [];
        const p2 = popRows2
          .map(r => ({
            url: String(r["URL"] ?? r["url"] ?? r["Page"] ?? ""),
            sessions: Number(r["totalSessionCount"] ?? r["count"] ?? 0),
          }))
          .filter(p => p.url && p.sessions > 0)
          .sort((a, b) => b.sessions - a.sessions)
          .slice(0, 8);
        if (p2.length > 0) topPages = p2;
      }
    } else {
      console.warn(`[clarity-data] Call 2 failed ${res2.status} for "${projectName}" (analytics unavailable)`);
    }

    return { sessions, pageViews, addToCart, checkout, removeFromCart, browsers, operatingSystems, channels, countries, topPages, projectName, ok: true };
  } catch (e) {
    console.error(`[clarity-data] fetch error for "${projectName}":`, e);
    return empty;
  }
}

function sumNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

/** Merge two [{name, sessions}] arrays by summing sessions per name */
function mergeArrayMetrics(
  a: { name: string; sessions: number }[],
  b: { name: string; sessions: number }[]
): { name: string; sessions: number }[] {
  const map = new Map<string, number>();
  for (const { name, sessions } of [...a, ...b]) {
    map.set(name, (map.get(name) ?? 0) + sessions);
  }
  return Array.from(map.entries())
    .map(([name, sessions]) => ({ name, sessions }))
    .sort((a, b) => b.sessions - a.sessions);
}

/** Merge two [{url, sessions}] arrays */
function mergePageMetrics(
  a: { url: string; sessions: number }[],
  b: { url: string; sessions: number }[]
): { url: string; sessions: number }[] {
  const map = new Map<string, number>();
  for (const { url, sessions } of [...a, ...b]) {
    map.set(url, (map.get(url) ?? 0) + sessions);
  }
  return Array.from(map.entries())
    .map(([url, sessions]) => ({ url, sessions }))
    .sort((a, b) => b.sessions - a.sessions);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // ── Auth ────────────────────────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Unauthorized" }, 401);

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(
    authHeader.replace("Bearer ", "")
  );
  if (authError || !user) return jsonResponse({ error: "Unauthorized" }, 401);

  // ── Parse body ──────────────────────────────────────────────────────────────
  let numOfDays = 1;
  let orgId: string | null = null;
  let clarityProjectId: string | null = null;

  try {
    const body = await req.json();
    if (body?.numOfDays && Number.isInteger(body.numOfDays) && body.numOfDays > 0)
      numOfDays = Math.min(body.numOfDays, 90);
    if (body?.orgId && typeof body.orgId === "string") orgId = body.orgId;
    if (body?.clarityProjectId && typeof body.clarityProjectId === "string")
      clarityProjectId = body.clarityProjectId;
  } catch { /* no body */ }

  const cacheScope = clarityProjectId ?? orgId ?? "global";
  const CACHE_KEY = `clarity_metrics_v5_${cacheScope}_${numOfDays}d`;

  // ── Cache check ─────────────────────────────────────────────────────────────
  const { data: cached } = await supabaseAdmin
    .from("system_cache")
    .select("payload, updated_at")
    .eq("cache_key", CACHE_KEY)
    .single();

  if (cached) {
    const age = Date.now() - new Date(cached.updated_at).getTime();
    if (age < CACHE_TTL) return jsonResponse({ ...cached.payload, _cached: true });
  }

  // ── Resolve projects to fetch ───────────────────────────────────────────────
  type ProjectRow = { id: string; project_name: string; api_token: string; shopify_store_id: string | null; clarity_project_id: string | null };
  let projectRows: ProjectRow[] = [];

  if (clarityProjectId) {
    const { data } = await supabaseAdmin
      .from("clarity_projects")
      .select("id, project_name, api_token, shopify_store_id, clarity_project_id")
      .eq("id", clarityProjectId)
      .eq("is_active", true)
      .single();
    if (data) projectRows = [data];
  } else if (orgId) {
    const { data } = await supabaseAdmin
      .from("clarity_projects")
      .select("id, project_name, api_token, shopify_store_id, clarity_project_id")
      .eq("organization_id", orgId)
      .eq("is_active", true)
      .order("connected_at");
    if (data?.length) projectRows = data;
  }

  // ── Backward-compat: fall back to organizations.clarity_api_token ───────────
  if (projectRows.length === 0 && orgId) {
    const globalToken = Deno.env.get("CLARITY_API_TOKEN");
    const { data: org } = await supabaseAdmin
      .from("organizations")
      .select("clarity_api_token")
      .eq("id", orgId)
      .single();

    const token = org?.clarity_api_token || globalToken || null;
    if (token) {
      projectRows = [{ id: "legacy", project_name: "Default Clarity Project", api_token: token, shopify_store_id: null, clarity_project_id: null }];
    }
  }

  if (projectRows.length === 0) {
    return jsonResponse({
      sessions: null, pageViews: null, addToCart: null, checkout: null, removeFromCart: null,
      browsers: [], operatingSystems: [], channels: [], countries: [], topPages: [],
      configured: false, projects: [],
    });
  }

  // ── Fetch all projects in parallel ─────────────────────────────────────────
  const results = await Promise.all(
    projectRows.map(p => fetchClarityProject(p.api_token, numOfDays, p.project_name))
  );

  // ── Merge: sum/aggregate across all projects ────────────────────────────────
  let sessions: number | null = null;
  let pageViews: number | null = null;
  let addToCart: number | null = null;
  let checkout: number | null = null;
  let removeFromCart: number | null = null;
  let browsers: { name: string; sessions: number }[] = [];
  let operatingSystems: { name: string; sessions: number }[] = [];
  let channels: { name: string; sessions: number }[] = [];
  let countries: { name: string; sessions: number }[] = [];
  let topPages: { url: string; sessions: number }[] = [];

  for (const r of results) {
    if (!r.ok) continue;
    sessions       = sumNullable(sessions, r.sessions);
    pageViews      = sumNullable(pageViews, r.pageViews);
    addToCart      = sumNullable(addToCart, r.addToCart);
    checkout       = sumNullable(checkout, r.checkout);
    removeFromCart = sumNullable(removeFromCart, r.removeFromCart);
    browsers         = mergeArrayMetrics(browsers, r.browsers).slice(0, 6);
    operatingSystems = mergeArrayMetrics(operatingSystems, r.operatingSystems).slice(0, 6);
    channels         = mergeArrayMetrics(channels, r.channels).slice(0, 6);
    countries        = mergeArrayMetrics(countries, r.countries).slice(0, 8);
    topPages         = mergePageMetrics(topPages, r.topPages).slice(0, 8);
  }

  const projects = projectRows.map((p, i) => ({
    id: p.id,
    project_name: p.project_name,
    clarity_project_id: p.clarity_project_id,
    shopify_store_id: p.shopify_store_id,
    ...results[i],
  }));

  const payload = {
    sessions, pageViews, addToCart, checkout, removeFromCart,
    browsers, operatingSystems, channels, countries, topPages,
    configured: true, projects,
  };

  await supabaseAdmin.from("system_cache").upsert(
    { cache_key: CACHE_KEY, payload, updated_at: new Date().toISOString() },
    { onConflict: "cache_key" }
  );

  return jsonResponse({ ...payload, _cached: false });
});
