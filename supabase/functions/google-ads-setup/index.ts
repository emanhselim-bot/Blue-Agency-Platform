/**
 * Google Ads Setup — Supabase Edge Function
 *
 * Called when auto-discovery failed and the user manually enters their
 * Google Ads Customer ID. Validates the CID against the stored tokens,
 * then replaces the SETUP_REQUIRED placeholder with the real account.
 *
 * POST { organization_id, customer_id }
 * → { success: true, account_name: string }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const GOOGLE_ADS_API = "https://googleads.googleapis.com/v24";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function refreshAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
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
    const t = await res.text();
    throw new Error(`Token refresh failed ${res.status}: ${t.slice(0, 200)}`);
  }
  const d = await res.json();
  return d.access_token as string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // Auth
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Unauthorized" }, 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(
    authHeader.replace("Bearer ", "")
  );
  if (authErr || !user) return json({ error: "Unauthorized" }, 401);

  let body: { organization_id?: string; customer_id?: string };
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { organization_id, customer_id } = body;
  if (!organization_id) return json({ error: "organization_id required" }, 400);
  if (!customer_id)     return json({ error: "customer_id required" }, 400);

  // Verify org membership
  const { data: member } = await supabaseAdmin
    .from("organization_members")
    .select("role")
    .eq("organization_id", organization_id)
    .eq("user_id", user.id)
    .not("accepted_at", "is", null)
    .single();
  if (!member) return json({ error: "Forbidden" }, 403);

  // Look up the SETUP_REQUIRED placeholder record for this org
  const { data: pending, error: pendingErr } = await supabaseAdmin
    .from("google_ads_accounts")
    .select("*")
    .eq("organization_id", organization_id)
    .eq("customer_id", "SETUP_REQUIRED")
    .single();

  if (pendingErr || !pending) {
    return json({ error: "No pending Google Ads setup found for this organization. Please reconnect via Settings → Google Ads." }, 404);
  }

  // Normalize the customer ID (strip dashes and whitespace)
  const cid = customer_id.replace(/[-\s]/g, "");
  if (!/^\d+$/.test(cid)) {
    return json({ error: "Invalid Customer ID — must be numeric (e.g. 123-456-7890 or 1234567890)." }, 400);
  }

  // Refresh the access token using stored credentials
  let accessToken: string;
  try {
    accessToken = await refreshAccessToken(pending.client_id, pending.client_secret, pending.refresh_token);
  } catch (e) {
    return json({ error: `Token refresh failed: ${(e as Error).message}` }, 502);
  }

  // Verify the Customer ID is accessible
  let accountName = cid;
  try {
    const res = await fetch(`${GOOGLE_ADS_API}/customers/${cid}/googleAds:search`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "developer-token": pending.developer_token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "SELECT customer.descriptive_name, customer.id FROM customer LIMIT 1" }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const t = await res.text();
      console.error("[google-ads-setup] verify CID error:", res.status, t.slice(0, 400));
      // Non-blocking: if we can't verify, still store the account
      // The user might have a valid CID even if the API has quirks
      if (res.status === 403) {
        return json({ error: `Access denied to Customer ID ${cid}. Make sure this account is accessible from the connected Google login. Google error: ${t.slice(0, 200)}` }, 403);
      }
      // For 401 or other errors, still store — user can try to use it
      console.warn("[google-ads-setup] CID verification non-fatal error, storing anyway");
    } else {
      const data = await res.json();
      accountName = data.results?.[0]?.customer?.descriptiveName ?? cid;
      console.log("[google-ads-setup] CID verified, account name:", accountName);
    }
  } catch (e) {
    console.warn("[google-ads-setup] CID verification exception (storing anyway):", (e as Error).message);
  }

  // Replace the SETUP_REQUIRED record with the real customer account
  // Step 1: delete the placeholder
  await supabaseAdmin
    .from("google_ads_accounts")
    .delete()
    .eq("organization_id", organization_id)
    .eq("customer_id", "SETUP_REQUIRED");

  // Step 2: insert the real account
  const { error: insertErr } = await supabaseAdmin
    .from("google_ads_accounts")
    .upsert([{
      organization_id,
      customer_id:     cid,
      account_name:    accountName !== cid ? accountName : null,
      developer_token: pending.developer_token,
      client_id:       pending.client_id,
      client_secret:   pending.client_secret,
      refresh_token:   pending.refresh_token,
      is_active:       true,
    }], { onConflict: "organization_id,customer_id" });

  if (insertErr) {
    console.error("[google-ads-setup] insert error:", insertErr);
    return json({ error: `Database error: ${insertErr.message}` }, 500);
  }

  console.log(`[google-ads-setup] linked CID ${cid} for org ${organization_id}`);
  return json({ success: true, customer_id: cid, account_name: accountName });
});
