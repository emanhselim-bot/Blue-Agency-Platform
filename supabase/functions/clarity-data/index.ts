/**
 * clarity-data — Supabase Edge Function
 * Deploy: supabase functions deploy clarity-data
 *
 * Supports multiple Clarity projects per org via the clarity_projects table.
 * Falls back to organizations.clarity_api_token for backward compatibility.
 *
 * Request body (all optional):
 *   orgId            — filter to this org
 *   numOfDays        — 1–90 (default 1)
 *   clarityProjectId — UUID from clarity_projects table; if omitted, fetches
 *                      ALL active projects for the org and merges results
 *
 * Returns:
 *   { sessions, pageViews, addToCart, checkout, removeFromCart,
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

const EVENT_FIELDS = ["count","totalCount","eventCount","totalEventCount","sessionCount","totalSessionCount"] as const;

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
  projectName: string;
  ok: boolean;
}> {
  try {
    const res = await fetch(
      `https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=${numOfDays}&dimension1=Device`,
      { headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" } }
    );

    if (!res.ok) {
      console.error(`Clarity API ${res.status} for "${projectName}":`, await res.text());
      return { sessions: null, pageViews: null, addToCart: null, checkout: null, removeFromCart: null, projectName, ok: false };
    }

    const data = await res.json();
    const allMetrics: ClarityMetric[] = Array.isArray(data) ? data : [];

    const trafficRows = allMetrics.find(m => (m.metricName ?? "").toLowerCase() === "traffic")?.information ?? [];
    const totalSessions = sumField(trafficRows, "totalSessionCount");

    const AVG_PAGE_FIELDS = ["PagesPerSessionPercentage","pagesPerSession","avgPages","avgPageViews","pageViewsPerSession","pages"];
    const avgPagesArr = trafficRows.map(r => {
      for (const f of AVG_PAGE_FIELDS) { const v = parseFloat(String(r[f] ?? "")); if (!isNaN(v) && v > 0) return v; }
      return 0;
    }).filter(v => v > 0);
    const avgPages = avgPagesArr.length > 0 ? avgPagesArr.reduce((a, b) => a + b, 0) / avgPagesArr.length : 0;

    const pvRows = findMetric(allMetrics, "PageViews","Page Views","Pageviews","page_views","Pages","PopularPages","Popular Pages");
    let pageViews: number | null = null;
    if (pvRows?.length) {
      const total = sumField(pvRows, "totalPageViewCount","pageViewCount","PageViews","pageViews","count","totalCount","totalSessionCount");
      if (total > 0) pageViews = total;
    }
    if (!pageViews && totalSessions > 0 && avgPages > 0) pageViews = Math.round(totalSessions * avgPages);

    const atcRows = findMetric(allMetrics, "AddToCart","Add To Cart","add_to_cart","addtocart","Add to Cart");
    const addToCart = atcRows ? (sumField(atcRows, ...EVENT_FIELDS) || null) : null;

    const coRows = findMetric(allMetrics, "Checkout","BeginCheckout","Begin Checkout","begin_checkout","begincheckout");
    const checkout = coRows ? (sumField(coRows, ...EVENT_FIELDS) || null) : null;

    const rfcRows = findMetric(allMetrics, "RemoveFromCart","Remove From Cart","remove_from_cart","removefromcart","Remove from Cart");
    const removeFromCart = rfcRows ? (sumField(rfcRows, ...EVENT_FIELDS) || null) : null;

    return { sessions: totalSessions > 0 ? totalSessions : null, pageViews, addToCart, checkout, removeFromCart, projectName, ok: true };
  } catch (e) {
    console.error(`clarity fetch error for "${projectName}":`, e);
    return { sessions: null, pageViews: null, addToCart: null, checkout: null, removeFromCart: null, projectName, ok: false };
  }
}

function sumNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
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
  let clarityProjectId: string | null = null; // UUID from clarity_projects table

  try {
    const body = await req.json();
    if (body?.numOfDays && Number.isInteger(body.numOfDays) && body.numOfDays > 0)
      numOfDays = Math.min(body.numOfDays, 90);
    if (body?.orgId && typeof body.orgId === "string") orgId = body.orgId;
    if (body?.clarityProjectId && typeof body.clarityProjectId === "string")
      clarityProjectId = body.clarityProjectId;
  } catch { /* no body */ }

  const cacheScope = clarityProjectId ?? orgId ?? "global";
  const CACHE_KEY = `clarity_metrics_v4_${cacheScope}_${numOfDays}d`;

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
    // Single specific project
    const { data } = await supabaseAdmin
      .from("clarity_projects")
      .select("id, project_name, api_token, shopify_store_id, clarity_project_id")
      .eq("id", clarityProjectId)
      .eq("is_active", true)
      .single();
    if (data) projectRows = [data];
  } else if (orgId) {
    // All active projects for this org
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
    return jsonResponse({ sessions: null, pageViews: null, addToCart: null, checkout: null, removeFromCart: null, configured: false, projects: [] });
  }

  // ── Fetch all projects in parallel ─────────────────────────────────────────
  const results = await Promise.all(
    projectRows.map(p => fetchClarityProject(p.api_token, numOfDays, p.project_name))
  );

  // Merge: sum all projects' metrics
  let sessions: number | null = null;
  let pageViews: number | null = null;
  let addToCart: number | null = null;
  let checkout: number | null = null;
  let removeFromCart: number | null = null;

  for (const r of results) {
    if (!r.ok) continue;
    sessions = sumNullable(sessions, r.sessions);
    pageViews = sumNullable(pageViews, r.pageViews);
    addToCart = sumNullable(addToCart, r.addToCart);
    checkout = sumNullable(checkout, r.checkout);
    removeFromCart = sumNullable(removeFromCart, r.removeFromCart);
  }

  // Per-project breakdown for the UI
  const projects = projectRows.map((p, i) => ({
    id: p.id,
    project_name: p.project_name,
    clarity_project_id: p.clarity_project_id,
    shopify_store_id: p.shopify_store_id,
    ...results[i],
  }));

  const payload = { sessions, pageViews, addToCart, checkout, removeFromCart, configured: true, projects };

  await supabaseAdmin.from("system_cache").upsert(
    { cache_key: CACHE_KEY, payload, updated_at: new Date().toISOString() },
    { onConflict: "cache_key" }
  );

  return jsonResponse({ ...payload, _cached: false });
});
