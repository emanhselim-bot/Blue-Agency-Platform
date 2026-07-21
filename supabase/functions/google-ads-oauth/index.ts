/**
 * Google Ads OAuth — Supabase Edge Function
 *
 * Route 1  GET ?action=connect&org=ORG_ID&t=JWT
 *   → Redirects user to Google's OAuth consent screen
 *
 * Route 2  GET ?code=AUTH_CODE&state=BASE64_STATE
 *   → Exchanges code for tokens, discovers all accessible Google Ads
 *     customer accounts, stores them in google_ads_accounts, and
 *     redirects back to the dashboard.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL        = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID           = Deno.env.get("GOOGLE_ADS_CLIENT_ID")!;
const CLIENT_SECRET       = Deno.env.get("GOOGLE_ADS_CLIENT_SECRET")!;
const DEVELOPER_TOKEN     = Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN")!;

const REDIRECT_URI        = `${SUPABASE_URL}/functions/v1/google-ads-oauth`;
const GOOGLE_ADS_API      = "https://googleads.googleapis.com/v24";
const SCOPES              = "https://www.googleapis.com/auth/adwords";

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
};

function redirect(url: string) {
  return new Response(null, { status: 302, headers: { Location: url } });
}

function errorPage(msg: string) {
  return new Response(
    `<html><body style="font-family:sans-serif;padding:40px">
      <h2>⚠️ Google Ads Connection Error</h2>
      <p>${msg}</p>
      <a href="javascript:history.back()">← Go back</a>
    </body></html>`,
    { status: 400, headers: { "Content-Type": "text/html" } }
  );
}

// ── Token exchange ────────────────────────────────────────────────────────────
async function exchangeCode(code: string): Promise<{ access_token: string; refresh_token: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri:  REDIRECT_URI,
      grant_type:    "authorization_code",
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Token exchange failed ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.json();
}

// ── List accessible customers ─────────────────────────────────────────────────
async function listAccessibleCustomers(accessToken: string): Promise<string[]> {
  const res = await fetch(`${GOOGLE_ADS_API}/customers:listAccessibleCustomers`, {
    headers: {
      "Authorization":  `Bearer ${accessToken}`,
      "developer-token": DEVELOPER_TOKEN,
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`listAccessibleCustomers ${res.status}: ${t.slice(0, 300)}`);
  }
  const json = await res.json();
  // Returns ["customers/1234567890", ...]
  return (json.resourceNames ?? []).map((r: string) => r.replace("customers/", ""));
}

// ── Get customer name ─────────────────────────────────────────────────────────
async function getCustomerName(customerId: string, accessToken: string): Promise<string> {
  try {
    const gaql = `SELECT customer.descriptive_name FROM customer LIMIT 1`;
    const res = await fetch(`${GOOGLE_ADS_API}/customers/${customerId}/googleAds:search`, {
      method: "POST",
      headers: {
        "Authorization":  `Bearer ${accessToken}`,
        "developer-token": DEVELOPER_TOKEN,
        "Content-Type":   "application/json",
      },
      body: JSON.stringify({ query: gaql }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return customerId;
    const json = await res.json();
    return json.results?.[0]?.customer?.descriptiveName ?? customerId;
  } catch {
    return customerId;
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const url    = new URL(req.url);
  const action = url.searchParams.get("action");
  const code   = url.searchParams.get("code");
  const stateB64 = url.searchParams.get("state");

  // ── Route 1: Initiate OAuth flow ──────────────────────────────────────────
  if (action === "connect") {
    const orgId = url.searchParams.get("org");
    const jwt   = url.searchParams.get("t");

    if (!orgId || !jwt) return errorPage("Missing org or token parameter.");
    if (!CLIENT_ID)     return errorPage("GOOGLE_ADS_CLIENT_ID secret not set.");

    // Verify user is a member of this org
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(jwt);
    if (error || !user) return errorPage("Invalid or expired session token.");

    const { data: member } = await supabaseAdmin
      .from("organization_members")
      .select("role")
      .eq("organization_id", orgId)
      .eq("user_id", user.id)
      .not("accepted_at", "is", null)
      .single();
    if (!member) return errorPage("You are not a member of this organization.");

    const state = btoa(JSON.stringify({ org_id: orgId, user_id: user.id, jwt }));
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id",     CLIENT_ID);
    authUrl.searchParams.set("redirect_uri",  REDIRECT_URI);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope",         SCOPES);
    authUrl.searchParams.set("access_type",   "offline");
    authUrl.searchParams.set("prompt",        "consent");   // always get refresh_token
    authUrl.searchParams.set("state",         state);

    return redirect(authUrl.toString());
  }

  // ── Route 2: OAuth callback ───────────────────────────────────────────────
  if (code && stateB64) {
    let stateObj: { org_id: string; user_id: string; jwt: string };
    try {
      stateObj = JSON.parse(atob(stateB64));
    } catch {
      return errorPage("Invalid state parameter.");
    }

    const { org_id, jwt } = stateObj;

    // Verify user session
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(jwt);
    if (error || !user) return errorPage("Session expired. Please try connecting again.");

    // Verify org membership
    const { data: member } = await supabaseAdmin
      .from("organization_members")
      .select("role")
      .eq("organization_id", org_id)
      .eq("user_id", user.id)
      .not("accepted_at", "is", null)
      .single();
    if (!member) return errorPage("Organization membership check failed.");

    // Exchange code for tokens
    let tokens: { access_token: string; refresh_token: string };
    try {
      tokens = await exchangeCode(code);
    } catch (e) {
      return errorPage(`Token exchange failed: ${(e as Error).message}`);
    }

    if (!tokens.refresh_token) {
      return errorPage("No refresh token returned — please revoke app access in your Google Account and try again.");
    }

    // List accessible Google Ads accounts
    let customerIds: string[];
    try {
      customerIds = await listAccessibleCustomers(tokens.access_token);
    } catch (e) {
      return errorPage(`Could not list Google Ads accounts: ${(e as Error).message}`);
    }

    if (!customerIds.length) {
      return errorPage("No Google Ads accounts found for this Google login. Make sure you're signing in with an account that has access to Google Ads.");
    }

    // Fetch account names in parallel (best-effort)
    const names = await Promise.all(customerIds.map(id => getCustomerName(id, tokens.access_token)));

    // Upsert each account
    const rows = customerIds.map((customerId, i) => ({
      organization_id: org_id,
      customer_id:     customerId,
      account_name:    names[i] !== customerId ? names[i] : null,
      developer_token: DEVELOPER_TOKEN,
      client_id:       CLIENT_ID,
      client_secret:   CLIENT_SECRET,
      refresh_token:   tokens.refresh_token,
      is_active:       true,
    }));

    const { error: upsertErr } = await supabaseAdmin
      .from("google_ads_accounts")
      .upsert(rows, { onConflict: "organization_id,customer_id" });

    if (upsertErr) {
      console.error("[google-ads-oauth] upsert error:", upsertErr);
      return errorPage(`Database error: ${upsertErr.message}`);
    }

    console.log(`[google-ads-oauth] connected ${rows.length} account(s) for org ${org_id}`);

    // Redirect back to dashboard
    const dashboardUrl = Deno.env.get("DASHBOARD_URL") || "https://web-production-b4926.up.railway.app";
    return redirect(`${dashboardUrl}?connected=google_ads&accounts=${rows.length}`);
  }

  return new Response("Google Ads OAuth handler — use ?action=connect to initiate.", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
});
