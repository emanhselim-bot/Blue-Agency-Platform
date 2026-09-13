/**
 * Meta Backfill — Supabase Edge Function
 *
 * Returns a whole account's history one month per row, in a single call.
 *
 * The dashboard's Monthly history fill asks Meta for one month at a time, for
 * whichever account is selected. Across 114 accounts and three years that is
 * over four thousand round trips, which Meta throttles long before it finishes.
 * `time_increment=monthly` returns the same figures as one response per
 * account, so a full backfill is ~114 calls instead.
 *
 * Two deliberate differences from meta-data:
 *
 *  - It does NOT filter on is_active. A paused or archived account still has a
 *    spend history worth keeping; refusing to read it is how that history gets
 *    lost. Organisation membership is still checked, so this reads nothing the
 *    caller could not already see.
 *
 *  - It follows Meta's paging. A three-year window split by placement is over a
 *    hundred rows, and Meta's default page is 25 — without this the older half
 *    of the history would silently go missing, which is worse than failing.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const META_API = "https://graph.facebook.com/v21.0";

// Meta keeps insights for roughly 37 months; asking for more just errors.
const MAX_MONTHS = 37;
const MAX_PAGES  = 12;

const BASE_FIELDS = [
  "spend", "impressions", "reach", "clicks",
  "actions", "date_start", "date_stop",
].join(",");

// Same candidate lists as meta-data: Meta names these differently across
// placements and API versions, so take the first that came back.
const VIDEO_VIEW_KEYS    = ["video_view"];
const PROFILE_VISIT_KEYS = [
  "profile_visit",
  "onsite_conversion.ig_profile_visit",
  "instagram_profile_visit",
  "onsite_conversion.profile_visit",
];
const FOLLOW_KEYS = ["follow", "onsite_conversion.follow", "page_like", "like"];

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

function firstOf(map: Record<string, string>, keys: string[]): string | null {
  for (const k of keys) if (map[k] != null) return map[k];
  return null;
}

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

function monthKey(dateStart: string): string {
  return String(dateStart).slice(0, 7) + "-01";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Unauthorized" }, 401);

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(
    authHeader.replace("Bearer ", ""),
  );
  if (authError || !user) return jsonResponse({ error: "Unauthorized" }, 401);

  let body: { account_db_id?: string; months?: number; split?: boolean };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { account_db_id, split = false } = body;
  const months = Math.min(MAX_MONTHS, Math.max(1, Number(body.months) || MAX_MONTHS));
  if (!account_db_id) return jsonResponse({ error: "account_db_id is required" }, 400);

  // No is_active filter — see the note at the top.
  const { data: account, error: accErr } = await supabaseAdmin
    .from("meta_ad_accounts")
    .select(`
      meta_account_id,
      currency,
      organization_id,
      account_name,
      is_active,
      meta_business_managers ( id, access_token, status )
    `)
    .eq("id", account_db_id)
    .single();

  if (accErr || !account) return jsonResponse({ error: "Account not found" }, 404);

  const bm          = (account as any).meta_business_managers;
  const accessToken = bm?.access_token;
  if (!accessToken) return jsonResponse({ error: "No access token for this account" }, 422);

  const { data: member } = await supabaseAdmin
    .from("organization_members")
    .select("id")
    .eq("organization_id", account.organization_id)
    .eq("user_id", user.id)
    .not("accepted_at", "is", null)
    .single();

  if (!member) return jsonResponse({ error: "Forbidden" }, 403);

  // Whole calendar months, ending with the month just gone: the current month
  // is still running and would be written as if it were a finished one.
  const now   = new Date();
  const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const since = new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth() - months + 1, 1));
  const iso   = (d: Date) => d.toISOString().slice(0, 10);

  const params = new URLSearchParams({
    fields:         split ? "spend,impressions,date_start,actions" : BASE_FIELDS,
    level:          "account",
    time_increment: "monthly",
    time_range:     JSON.stringify({ since: iso(since), until: iso(until) }),
    limit:          "500",
    access_token:   accessToken,
  });
  if (split) params.set("breakdowns", "publisher_platform");

  let url: string | null = `${META_API}/act_${account.meta_account_id}/insights?${params.toString()}`;
  const rows: Record<string, unknown>[] = [];

  try {
    for (let page = 0; page < MAX_PAGES && url; page++) {
      const res  = await fetch(url);
      const json = await res.json();
      if (json.error) {
        const code = json.error.code;
        if (code === 190 || json.error.type === "OAuthException") {
          if (bm?.id) {
            await supabaseAdmin.from("meta_business_managers")
              .update({ status: "expired", updated_at: new Date().toISOString() })
              .eq("id", bm.id);
          }
          return jsonResponse({ error: "TOKEN_EXPIRED" }, 401);
        }
        // 4 and 17 are Meta's rate limits, 613 its per-account throttle. The
        // caller needs to tell these apart from a real failure so it can wait
        // and come back rather than mark the account as having no history.
        if (code === 4 || code === 17 || code === 613) {
          return jsonResponse({ error: "RATE_LIMITED", message: json.error.message }, 429);
        }
        return jsonResponse({ error: json.error.message ?? "Meta API error" }, 422);
      }
      for (const r of (json.data ?? [])) rows.push(r);
      url = json.paging?.next ?? null;
    }
  } catch (e) {
    console.error("Meta unreachable:", e);
    return jsonResponse({ error: "Meta API unreachable" }, 502);
  }

  const num = (v: unknown) => {
    const n = parseFloat(String(v ?? ""));
    return isNaN(n) ? 0 : n;
  };

  if (split) {
    // One row per month per placement.
    const placements = rows.map(r => {
      const acts: Record<string, string> = {};
      for (const a of (r.actions as { action_type: string; value: string }[]) ?? []) {
        acts[a.action_type] = a.value;
      }
      let results: string | null = null;
      for (const k of RESULT_PRIORITY) if (acts[k] != null) { results = acts[k]; break; }
      return {
        month:       monthKey(r.date_start as string),
        platform:    String(r.publisher_platform ?? "").toLowerCase(),
        spend:       num(r.spend),
        impressions: num(r.impressions),
        results:     results == null ? null : num(results),
      };
    }).filter(p => p.platform === "facebook" || p.platform === "instagram");

    return jsonResponse({
      account_db_id, account_name: account.account_name,
      is_active: account.is_active, currency: account.currency,
      months: placements.length, placements,
    });
  }

  const monthly = rows.map(r => {
    const acts: Record<string, string> = {};
    for (const a of (r.actions as { action_type: string; value: string }[]) ?? []) {
      acts[a.action_type] = a.value;
    }
    const video   = firstOf(acts, VIDEO_VIEW_KEYS);
    const profile = firstOf(acts, PROFILE_VISIT_KEYS);
    const follow  = firstOf(acts, FOLLOW_KEYS);
    return {
      month:          monthKey(r.date_start as string),
      spend:          num(r.spend),
      impressions:    num(r.impressions),
      reach:          num(r.reach),
      clicks:         num(r.clicks),
      // null, not 0 — "Meta did not report this" and "none happened" are
      // different facts, and writing a zero would make an empty band look real.
      engagement:     acts["page_engagement"] != null ? num(acts["page_engagement"]) : null,
      video_views:    video   == null ? null : num(video),
      profile_visits: profile == null ? null : num(profile),
      follows:        follow  == null ? null : num(follow),
    };
  });

  return jsonResponse({
    account_db_id,
    account_name: account.account_name,
    is_active:    account.is_active,
    currency:     account.currency,
    since:        iso(since),
    until:        iso(until),
    months:       monthly.length,
    monthly,
  });
});
