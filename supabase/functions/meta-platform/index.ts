/**
 * Per-placement awareness figures
 *
 * Meta's own publisher_platform breakdown, carrying the awareness metrics that
 * an awareness client is actually judged on: reach, impressions, engagement,
 * video plays, follows and spend, for Facebook and Instagram separately.
 *
 * Why it exists: an awareness brief is often written per platform — "500K
 * reach on Instagram" — and the account total cannot answer it, because
 * Facebook delivery counts towards the same number. A target set against the
 * account total would report itself met while Instagram fell short.
 *
 * Why it is its own function rather than more fields on meta-data: meta-data is
 * the path every figure on every template takes, and it is a 700-line file.
 * Adding to it means redeploying it. This is the same decision, and the same
 * tradeoff, as notion-discover against notion-sync: a little duplicated
 * plumbing here, in exchange for being unable to break the main data path.
 *
 * Reads only. Writes nothing, and holds no state.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const META_API = "https://graph.facebook.com/v21.0";

const FIELDS = "spend,impressions,reach,clicks,actions,cost_per_action_type";

// Meta names the same action differently across placements and has renamed
// them between API versions, so each metric takes the first name that actually
// came back and records which one it used. A null with no basis means nothing
// of that kind was tracked — not that it was zero.
const VIDEO_VIEW_KEYS = ["video_view"];
const ENGAGEMENT_KEYS = ["page_engagement", "post_engagement"];
const FOLLOW_KEYS = ["follow", "onsite_conversion.follow", "page_like", "like"];
const PROFILE_VISIT_KEYS = [
  "profile_visit",
  "onsite_conversion.ig_profile_visit",
  "instagram_profile_visit",
  "onsite_conversion.profile_visit",
];

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

function firstOf(map: Record<string, string>, keys: string[]) {
  for (const k of keys) if (map[k] != null) return { value: map[k], basis: k };
  return { value: null as string | null, basis: null as string | null };
}

const META_DATE_PRESETS: Record<string, string> = {
  today: "today", yesterday: "yesterday", last_7_days: "last_7_days",
  last_30_days: "last_30_days", this_month: "this_month", last_month: "last_month",
  this_quarter: "this_quarter", last_quarter: "last_quarter", this_year: "this_year",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const auth = req.headers.get("Authorization");
  if (!auth) return json({ error: "Unauthorized" }, 401);
  const { data: { user }, error: authErr } =
    await admin.auth.getUser(auth.replace("Bearer ", ""));
  if (authErr || !user) return json({ error: "Unauthorized" }, 401);

  let body: {
    account_db_id?: string;
    period?: string;
    custom_from?: string;
    custom_to?: string;
  };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  const { account_db_id, period = "today", custom_from, custom_to } = body;
  if (!account_db_id) return json({ error: "account_db_id is required" }, 400);

  const { data: account, error: accErr } = await admin
    .from("meta_ad_accounts")
    .select(`
      meta_account_id,
      currency,
      organization_id,
      meta_business_managers ( id, access_token, status )
    `)
    .eq("id", account_db_id)
    .eq("is_active", true)
    .single();

  if (accErr || !account) return json({ error: "Account not found or inactive" }, 404);

  // deno-lint-ignore no-explicit-any
  const bm = (account as any).meta_business_managers;
  const accessToken = bm?.access_token;
  if (!accessToken) return json({ error: "No access token found for this account" }, 422);

  // Membership of the account's organization, the same gate meta-data applies.
  // Holding a valid login is not by itself permission to read a client.
  const { data: member } = await admin
    .from("organization_members")
    .select("id")
    .eq("organization_id", account.organization_id)
    .eq("user_id", user.id)
    .not("accepted_at", "is", null)
    .maybeSingle();
  if (!member) return json({ error: "Forbidden" }, 403);

  const dateParams: Record<string, string> =
    period === "custom" && custom_from && custom_to
      ? { time_range: JSON.stringify({ since: custom_from, until: custom_to }) }
      : { date_preset: META_DATE_PRESETS[period] ?? "today" };

  const params = new URLSearchParams({
    fields: FIELDS,
    access_token: accessToken,
    breakdowns: "publisher_platform",
    ...dateParams,
  });

  let payload: Record<string, unknown>;
  try {
    const res = await fetch(
      `${META_API}/act_${account.meta_account_id}/insights?${params.toString()}`,
    );
    payload = await res.json();
  } catch (e) {
    console.error("Meta API unreachable:", e);
    return json({ error: "Meta API unreachable" }, 502);
  }

  // deno-lint-ignore no-explicit-any
  const err = (payload as any).error;
  if (err) {
    if (err.code === 190 || err.type === "OAuthException") {
      if (bm?.id) {
        await admin.from("meta_business_managers")
          .update({ status: "expired", updated_at: new Date().toISOString() })
          .eq("id", bm.id);
      }
      return json({ error: "TOKEN_EXPIRED" }, 401);
    }
    return json({ error: err.message ?? "Meta API error" }, 422);
  }

  const rows = (payload.data as Record<string, unknown>[]) ?? [];
  const platforms = rows.map(r => {
    const acts: Record<string, string> = {};
    for (const a of (r.actions as { action_type: string; value: string }[]) ?? []) {
      acts[a.action_type] = a.value;
    }
    const cpa: Record<string, string> = {};
    for (const a of (r.cost_per_action_type as { action_type: string; value: string }[]) ?? []) {
      cpa[a.action_type] = a.value;
    }
    const eng = firstOf(acts, ENGAGEMENT_KEYS);
    const vv  = firstOf(acts, VIDEO_VIEW_KEYS);
    const fol = firstOf(acts, FOLLOW_KEYS);
    const pv  = firstOf(acts, PROFILE_VISIT_KEYS);
    return {
      platform:            r.publisher_platform as string,
      spend:               r.spend ?? null,
      impressions:         r.impressions ?? null,
      reach:               r.reach ?? null,
      clicks:              r.clicks ?? null,
      engagement:          eng.value,
      engagement_basis:    eng.basis,
      cost_per_engagement: eng.basis ? (cpa[eng.basis] ?? null) : null,
      video_views:         vv.value,
      video_view_basis:    vv.basis,
      follows:             fol.value,
      follow_basis:        fol.basis,
      profile_visits:      pv.value,
      profile_visit_basis: pv.basis,
      // Every action type Meta returned for this placement, so a metric that
      // is missing above can be identified from real data rather than guessed.
      actions_all:         acts,
    };
  }).sort((a, b) => parseFloat(String(b.spend ?? 0)) - parseFloat(String(a.spend ?? 0)));

  return json({ platforms, currency: account.currency });
});
