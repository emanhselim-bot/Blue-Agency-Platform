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

const CACHE_KEY = "clarity_metrics_v1";
const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // 1. Auth
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Unauthorized" }, 401);

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(
    authHeader.replace("Bearer ", "")
  );
  if (authError || !user) return jsonResponse({ error: "Unauthorized" }, 401);

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

  // 3. Fetch from Clarity Export API (counts as 1 of 10 daily calls)
  const token = Deno.env.get("CLARITY_API_TOKEN");
  if (!token) {
    return jsonResponse({ sessions: null, mobilePercent: null, pagesPerSession: null, configured: false });
  }

  try {
    const res = await fetch(
      "https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=3&dimension1=Device",
      { headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" } }
    );

    if (!res.ok) {
      const text = await res.text();
      console.error(`Clarity API ${res.status}:`, text);
      if (cached) return jsonResponse({ ...cached.payload, _stale: true });
      return jsonResponse({ sessions: null, mobilePercent: null, pagesPerSession: null, configured: true });
    }

    const data = await res.json();

    // Parse Traffic metric rows (one row per device type)
    const trafficMetric = Array.isArray(data)
      ? data.find((m: Record<string, unknown>) => m.metricName === "Traffic")
      : null;
    const rows: Record<string, string>[] = (trafficMetric?.information as Record<string, string>[]) ?? [];

    const totalSessions  = rows.reduce((s, r) => s + parseInt(r.totalSessionCount || "0"), 0);
    const mobileSessions = rows
      .filter(r => r.Device === "Mobile")
      .reduce((s, r) => s + parseInt(r.totalSessionCount || "0"), 0);
    const avgPages = rows.length > 0
      ? rows.reduce((s, r) => s + (parseFloat(r.PagesPerSessionPercentage) || 0), 0) / rows.length
      : 0;

    const payload = {
      sessions:       totalSessions,
      mobilePercent:  totalSessions > 0
        ? parseFloat(((mobileSessions / totalSessions) * 100).toFixed(1))
        : null,
      pagesPerSession: parseFloat(avgPages.toFixed(2)),
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
    return jsonResponse({ sessions: null, mobilePercent: null, pagesPerSession: null, configured: true });
  }
});
