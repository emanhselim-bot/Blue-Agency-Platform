/**
 * TikTok Ads OAuth — Supabase Edge Function
 *
 * Why this exists: TikTok was the only ad platform in this dashboard without
 * one. Meta has meta-oauth, Google Ads has google-ads-oauth, and TikTok had a
 * form you pasted a raw long-lived access token into — a credential that never
 * expires, typed into a browser field, sitting in a clipboard and a chat
 * history on the way there. This removes that step: the token is minted
 * server-side from the auth_code and written straight to the table. Nobody
 * sees it, including whoever clicks Connect.
 *
 * Two routes in, because TikTok makes you register redirect URLs in advance
 * and this function's URL may not be one of them:
 *
 *   GET  ?action=connect&org=ORG_ID&t=JWT
 *        → sends the user to TikTok's advertiser authorization page
 *
 *   GET  ?auth_code=…&state=…        (TikTok redirected straight here)
 *   POST {auth_code, organization_id} (TikTok redirected to the dashboard,
 *                                      which hands the code over)
 *        → exchanges the code, lists the advertisers it covers, writes them all
 *
 * The POST route is what makes this usable before anyone edits the app's
 * redirect list: the dashboard URL is already registered, so the code can land
 * there and be passed on. An auth_code is not a credential on its own — it is
 * single-use, expires in an hour, and is worthless without the app secret,
 * which lives only here.
 *
 * Secrets required: TIKTOK_APP_ID, TIKTOK_APP_SECRET (App Detail → Basic
 * Information in the TikTok API for Business portal).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_ID           = Deno.env.get("TIKTOK_APP_ID") ?? "";
const APP_SECRET       = Deno.env.get("TIKTOK_APP_SECRET") ?? "";

const DASHBOARD_URL = Deno.env.get("DASHBOARD_URL")
  ?? "https://web-production-b4926.up.railway.app";

const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/tiktok-oauth`;
const TIKTOK_API   = "https://business-api.tiktok.com/open_api/v1.3";
const TIKTOK_AUTH  = "https://business-api.tiktok.com/portal/auth";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const redirect = (url: string) =>
  new Response(null, { status: 302, headers: { Location: url } });

const errorPage = (msg: string) =>
  new Response(
    `<html><body style="font-family:sans-serif;padding:40px">
      <h2>⚠️ TikTok Ads connection error</h2>
      <p>${msg.replace(/[<>]/g, "")}</p>
      <a href="${DASHBOARD_URL}">← Back to the dashboard</a>
    </body></html>`,
    // charset matters: without it browsers fall back to latin-1 and the
    // warning sign and em-dashes in this page render as mojibake.
    { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

/** Accepted member of the organization. A valid login is not by itself access. */
async function memberOf(orgId: string, jwt: string): Promise<string | null> {
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data.user) return null;
  const { data: member } = await admin
    .from("organization_members")
    .select("id")
    .eq("organization_id", orgId)
    .eq("user_id", data.user.id)
    .not("accepted_at", "is", null)
    .maybeSingle();
  return member ? data.user.id : null;
}

/**
 * auth_code → long-lived access token.
 *
 * The token TikTok returns does not expire; it dies only when the advertiser
 * revokes the authorization. So this runs once per connection and the result
 * is never logged, never returned, and never leaves this function except into
 * the access_token column.
 */
async function exchange(authCode: string): Promise<{ token: string; advertiserIds: string[] }> {
  const res = await fetch(`${TIKTOK_API}/oauth2/access_token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: APP_ID, secret: APP_SECRET, auth_code: authCode }),
    signal: AbortSignal.timeout(20_000),
  });

  const payload = await res.json().catch(() => null);
  if (!res.ok || payload?.code !== 0) {
    // TikTok names the offending field in `message`, and the usual causes are
    // worth telling apart: a code reused, a code older than an hour, or the
    // app id and secret not matching the app the code came from.
    throw new Error(payload?.message ?? `TikTok returned ${res.status}`);
  }
  const token = payload?.data?.access_token;
  if (!token) throw new Error("TikTok returned no access token.");
  return { token, advertiserIds: (payload?.data?.advertiser_ids ?? []) as string[] };
}

/** Advertiser names, so the dashboard lists "Cytarose" rather than an id. */
async function advertiserNames(token: string): Promise<Record<string, string>> {
  try {
    const qs = new URLSearchParams({ app_id: APP_ID, secret: APP_SECRET });
    const res = await fetch(`${TIKTOK_API}/oauth2/advertiser/get/?${qs}`, {
      headers: { "Access-Token": token, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await res.json().catch(() => null);
    if (payload?.code !== 0) return {};
    const out: Record<string, string> = {};
    for (const a of payload?.data?.list ?? []) {
      if (a?.advertiser_id) out[String(a.advertiser_id)] = String(a.advertiser_name ?? "");
    }
    return out;
  } catch {
    // Names are a nicety. Losing them must not lose the connection.
    return {};
  }
}

/**
 * Write every advertiser the token covers.
 *
 * One token, many advertisers: that is how TikTok's authorization works, and
 * it is why the old manual form made you paste the same secret into five rows.
 */
async function connectAll(orgId: string, authCode: string): Promise<number> {
  const { token, advertiserIds } = await exchange(authCode);
  if (!advertiserIds.length) {
    throw new Error("The authorization covered no ad accounts. Pick at least one on TikTok's page.");
  }
  const names = await advertiserNames(token);

  const rows = advertiserIds.map(id => ({
    organization_id: orgId,
    advertiser_id:   String(id),
    access_token:    token,
    account_name:    names[String(id)] || null,
    is_active:       true,
  }));

  const { error } = await admin
    .from("tiktok_ads_accounts")
    .upsert(rows, { onConflict: "organization_id,advertiser_id" });
  if (error) throw new Error(`Could not save the connection: ${error.message}`);

  return rows.length;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const url = new URL(req.url);

  // ── The dashboard hands over a code TikTok delivered to it ────────────────
  if (req.method === "POST") {
    let body: { auth_code?: string; organization_id?: string };
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);
    if (!body.organization_id || !body.auth_code) {
      return json({ error: "organization_id and auth_code are required" }, 400);
    }
    if (!APP_ID || !APP_SECRET) {
      return json({ error: "TIKTOK_APP_ID and TIKTOK_APP_SECRET are not set" }, 422);
    }

    const userId = await memberOf(body.organization_id, authHeader.replace("Bearer ", ""));
    if (!userId) return json({ error: "Forbidden" }, 403);

    try {
      const count = await connectAll(body.organization_id, body.auth_code);
      return json({ ok: true, accounts: count });
    } catch (e) {
      return json({ error: (e as Error).message }, 502);
    }
  }

  const action   = url.searchParams.get("action");
  const authCode = url.searchParams.get("auth_code");
  const stateB64 = url.searchParams.get("state");

  // ── Route 1: send the user to TikTok ──────────────────────────────────────
  if (action === "connect") {
    const orgId = url.searchParams.get("org");
    const jwt   = url.searchParams.get("t");
    if (!orgId || !jwt) return errorPage("Missing org or token parameter.");
    if (!APP_ID) return errorPage("TIKTOK_APP_ID is not set on this project.");

    const userId = await memberOf(orgId, jwt);
    if (!userId) return errorPage("You are not a member of this organization, or the session expired.");

    const state = btoa(JSON.stringify({ org_id: orgId, jwt }));
    const auth = new URL(TIKTOK_AUTH);
    auth.searchParams.set("app_id", APP_ID);
    auth.searchParams.set("redirect_uri", REDIRECT_URI);
    auth.searchParams.set("state", state);
    return redirect(auth.toString());
  }

  // ── Route 2: TikTok redirected here with the code ─────────────────────────
  if (authCode && stateB64) {
    let st: { org_id: string; jwt: string };
    try { st = JSON.parse(atob(stateB64)); } catch { return errorPage("Invalid state parameter."); }

    const userId = await memberOf(st.org_id, st.jwt);
    if (!userId) return errorPage("Session expired. Start the connection again from Settings.");

    try {
      const count = await connectAll(st.org_id, authCode);
      return redirect(`${DASHBOARD_URL}?connected=tiktok_ads&accounts=${count}`);
    } catch (e) {
      return errorPage((e as Error).message);
    }
  }

  return new Response(
    "TikTok Ads OAuth handler — use ?action=connect&org=…&t=… to start.",
    { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
});
