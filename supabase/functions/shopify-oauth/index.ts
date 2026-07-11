/**
 * Shopify OAuth — Supabase Edge Function
 *
 * Deploy as TWO separate functions:
 *   supabase functions deploy shopify-oauth          (handles initiation)
 *   supabase functions deploy shopify-oauth-callback (handles callback)
 *
 * Or deploy as one function named "shopify-oauth" and route by path.
 *
 * Environment variables required (set via: supabase secrets set KEY=value):
 *   SHOPIFY_CLIENT_ID      — from Shopify Partner Dashboard → App → Client credentials
 *   SHOPIFY_CLIENT_SECRET  — from Shopify Partner Dashboard → App → Client credentials
 *   JWT_SECRET             — any long random string (used to sign state param)
 *   APP_URL                — your dashboard URL (e.g. https://yourdomain.com)
 *   SUPABASE_URL           — set automatically by Supabase
 *   SUPABASE_SERVICE_ROLE_KEY — set automatically by Supabase
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Scopes: minimum required for the dashboard metrics
const SHOPIFY_SCOPES = [
  "read_orders",
  "read_products",
  "read_analytics",
  "read_inventory",
  "read_reports",
].join(",");

// Webhook topics to register on every connected store.
// Order matters only for readability — all are registered in parallel.
// GDPR topics (customers/data_request, customers/redact, shop/redact) are
// MANDATORY for any app submitted to the Shopify App Store.
const WEBHOOK_TOPICS = [
  "app/uninstalled",
  "orders/create",
  "orders/updated",
  "customers/data_request",
  "customers/redact",
  "shop/redact",
] as const;

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// ── Minimal HMAC-SHA256 state signing (no external JWT library needed) ──
async function signState(payload: object): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(Deno.env.get("JWT_SECRET")!),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const data = JSON.stringify({ ...payload, exp: Date.now() + 600_000 });
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const sigHex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return btoa(data) + "." + sigHex;
}

async function verifyState(state: string): Promise<Record<string, unknown> | null> {
  const [b64, sigHex] = state.split(".");
  if (!b64 || !sigHex) return null;
  const data = atob(b64);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(Deno.env.get("JWT_SECRET")!),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const sigBytes = new Uint8Array(sigHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(data));
  if (!valid) return null;
  const payload = JSON.parse(data);
  if (payload.exp < Date.now()) return null; // expired
  return payload;
}

// ── Shopify HMAC verification (Critical fix #3) ───────────────────
// Shopify signs every OAuth callback with HMAC-SHA256 of all query
// parameters except "hmac" itself, sorted alphabetically and joined
// as key=value pairs. We verify this BEFORE touching the code or state
// params so a forged callback cannot trigger a token exchange.
// Constant-time comparison prevents timing-based oracle attacks.
async function verifyShopifyHmac(url: URL): Promise<boolean> {
  const providedHmac = url.searchParams.get("hmac");
  if (!providedHmac) return false;

  // Collect all params except "hmac", sort alphabetically
  const pairs: [string, string][] = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (key !== "hmac") pairs.push([key, value]);
  }
  pairs.sort(([a], [b]) => a.localeCompare(b));
  const message = pairs.map(([k, v]) => `${k}=${v}`).join("&");

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(Deno.env.get("SHOPIFY_CLIENT_SECRET")!),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const computedHmac = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison — prevents timing attacks
  if (computedHmac.length !== providedHmac.length) return false;
  let mismatch = 0;
  for (let i = 0; i < computedHmac.length; i++) {
    mismatch |= computedHmac.charCodeAt(i) ^ providedHmac.charCodeAt(i);
  }
  return mismatch === 0;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const url = new URL(req.url);

  // ═══════════════════════════════════════════════════════════════
  // ROUTE 1: Initiate OAuth
  // Called from dashboard: GET /functions/v1/shopify-oauth?shop=...&org_id=...
  // ═══════════════════════════════════════════════════════════════
  if (!url.pathname.includes("callback")) {
    // Authenticate caller — accept JWT from Authorization header OR ?t= param.
    // Browser redirects (window.location.href) cannot set request headers, so
    // the dashboard passes the session token as the t= query param instead.
    const authHeader = req.headers.get("Authorization");
    const userToken  = authHeader?.replace("Bearer ", "") || url.searchParams.get("t");
    if (!userToken) return new Response("Unauthorized", { status: 401 });
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(userToken);
    if (error || !user) return new Response("Unauthorized", { status: 401 });

    const shop = url.searchParams.get("shop")?.toLowerCase().replace(/^https?:\/\//, "");
    const orgId = url.searchParams.get("org_id");
    if (!shop || !orgId) {
      return new Response("Missing: shop and org_id are required", { status: 400 });
    }

    // Normalize: add .myshopify.com if user only typed the subdomain
    const shopDomain = shop.includes(".") ? shop : `${shop}.myshopify.com`;

    // Verify caller is an ACCEPTED admin/owner of this org.
    // Critical fix #4: .not("accepted_at", "is", null) ensures users with
    // a pending or revoked invitation (accepted_at = NULL) cannot initiate
    // an OAuth flow — only fully accepted members are allowed through.
    const { data: member } = await supabaseAdmin
      .from("organization_members")
      .select("role")
      .eq("organization_id", orgId)
      .eq("user_id", user.id)
      .not("accepted_at", "is", null)
      .single();

    if (!member || !["owner", "admin"].includes(member.role)) {
      return new Response("Forbidden: must be org admin or owner", { status: 403 });
    }

    // Build signed state param (prevents CSRF)
    const state = await signState({ org_id: orgId, user_id: user.id, shop: shopDomain });

    const callbackUrl = Deno.env.get("APP_URL") || `${Deno.env.get("SUPABASE_URL")}/functions/v1/shopify-oauth-callback`;
    const shopifyAuthUrl =
      `https://${shopDomain}/admin/oauth/authorize?` +
      new URLSearchParams({
        client_id: Deno.env.get("SHOPIFY_CLIENT_ID")!,
        scope: SHOPIFY_SCOPES,
        redirect_uri: callbackUrl,
        state,
      }).toString();

    return Response.redirect(shopifyAuthUrl, 302);
  }

  // ═══════════════════════════════════════════════════════════════
  // ROUTE 2: OAuth Callback
  // Shopify redirects here after the merchant authorizes the app.
  // GET /functions/v1/shopify-oauth-callback?code=...&shop=...&state=...
  // ═══════════════════════════════════════════════════════════════
  const code = url.searchParams.get("code");
  const shop = url.searchParams.get("shop");
  const state = url.searchParams.get("state");
  const shopifyError = url.searchParams.get("error");

  const appUrl = Deno.env.get("APP_URL") || "https://yourdomain.com";

  if (shopifyError) {
    return Response.redirect(`${appUrl}?shopify_error=${encodeURIComponent(shopifyError)}`, 302);
  }

  if (!code || !shop || !state) {
    return Response.redirect(`${appUrl}?shopify_error=missing_params`, 302);
  }

  // Critical fix #3: Verify Shopify's HMAC signature BEFORE exchanging
  // the authorization code. This ensures the callback came from Shopify
  // and was not forged by a third party who knows our callback URL.
  // We check HMAC first so a forged request cannot even reach state or
  // code validation.
  if (!await verifyShopifyHmac(url)) {
    return Response.redirect(`${appUrl}?shopify_error=invalid_hmac`, 302);
  }

  // Verify state
  const statePayload = await verifyState(state);
  if (!statePayload) {
    return Response.redirect(`${appUrl}?shopify_error=invalid_state`, 302);
  }

  const orgId = statePayload.org_id as string;

  // Exchange authorization code for permanent access token
  const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: Deno.env.get("SHOPIFY_CLIENT_ID")!,
      client_secret: Deno.env.get("SHOPIFY_CLIENT_SECRET")!,
      code,
    }),
  });

  if (!tokenResponse.ok) {
    return Response.redirect(`${appUrl}?shopify_error=token_exchange_failed`, 302);
  }

  const { access_token, scope } = await tokenResponse.json();

  if (!access_token) {
    return Response.redirect(`${appUrl}?shopify_error=no_token`, 302);
  }

  // Fetch shop info to get the human-readable name
  const shopInfoResponse = await fetch(`https://${shop}/admin/api/2024-01/shop.json`, {
    headers: { "X-Shopify-Access-Token": access_token },
  });
  const { shop: shopData } = await shopInfoResponse.json();

  // Upsert store record — updates token if store was previously connected
  const { error: upsertError } = await supabaseAdmin.from("shopify_stores").upsert(
    {
      organization_id: orgId,
      shop_domain: shop,
      shop_name: shopData?.name || shop,
      access_token,
      scopes: scope,
      is_active: true,
      connected_at: new Date().toISOString(),
    },
    { onConflict: "organization_id,shop_domain" }
  );

  if (upsertError) {
    console.error("DB upsert error:", upsertError);
    return Response.redirect(`${appUrl}?shopify_error=db_error`, 302);
  }

  // Fetch the store row ID we just upserted so we can track webhook registrations
  const { data: storeRow } = await supabaseAdmin
    .from("shopify_stores")
    .select("id")
    .eq("organization_id", orgId)
    .eq("shop_domain", shop)
    .single();

  // Register webhooks — non-blocking: failures are logged but don't abort OAuth
  if (storeRow?.id) {
    registerWebhooks(shop, access_token, storeRow.id, orgId).catch((err) =>
      console.error("registerWebhooks failed (non-fatal):", err)
    );
  }

  // Success — redirect back to dashboard with success signal
  return Response.redirect(`${appUrl}?shopify_connected=${encodeURIComponent(shop)}`, 302);
});

// ── registerWebhooks ──────────────────────────────────────────────────────────
// Called after a successful OAuth flow. Idempotent: lists existing webhooks for
// our endpoint URL, skips topics already registered, creates missing ones, and
// upserts a tracking row into shopify_webhook_subscriptions.
//
// Why idempotent? A merchant may revoke and reinstall the app. On reinstall,
// OAuth runs again. Without this check we'd accumulate duplicate webhooks and
// receive every event multiple times.
async function registerWebhooks(
  shopDomain: string,
  accessToken: string,
  storeId:     string,
  orgId:       string
): Promise<void> {
  const webhookEndpoint = `${Deno.env.get("SUPABASE_URL")}/functions/v1/shopify-webhook`;
  const shopifyApi      = `https://${shopDomain}/admin/api/2024-01`;
  const headers         = {
    "X-Shopify-Access-Token": accessToken,
    "Content-Type": "application/json",
  };

  // 1. Fetch all existing webhooks registered on this store
  let existingWebhooks: Array<{ id: number; topic: string; address: string }> = [];
  try {
    const listRes = await fetch(`${shopifyApi}/webhooks.json`, { headers });
    if (listRes.ok) {
      const { webhooks } = await listRes.json();
      existingWebhooks = webhooks ?? [];
    }
  } catch (err) {
    console.warn("registerWebhooks: could not list existing webhooks:", err);
  }

  // Build a set of topics already covered by our endpoint so we skip them
  const alreadyRegistered = new Set(
    existingWebhooks
      .filter(w => w.address === webhookEndpoint)
      .map(w => w.topic)
  );

  // 2. Register each missing topic
  const registrationResults = await Promise.allSettled(
    WEBHOOK_TOPICS
      .filter(topic => !alreadyRegistered.has(topic))
      .map(async (topic) => {
        const res = await fetch(`${shopifyApi}/webhooks.json`, {
          method:  "POST",
          headers,
          body:    JSON.stringify({
            webhook: { topic, address: webhookEndpoint, format: "json" },
          }),
        });

        if (!res.ok) {
          const errBody = await res.text();
          throw new Error(`${topic} → HTTP ${res.status}: ${errBody.slice(0, 200)}`);
        }

        const { webhook } = await res.json();
        return { topic, shopify_webhook_id: String(webhook.id) };
      })
  );

  // 3. Also track already-registered webhooks so the DB stays in sync
  const existingEntries = existingWebhooks
    .filter(w => w.address === webhookEndpoint)
    .map(w => ({
      store_id:           storeId,
      organization_id:    orgId,
      topic:              w.topic,
      shopify_webhook_id: String(w.id),
      address:            webhookEndpoint,
    }));

  // 4. Collect newly registered entries
  const newEntries = registrationResults
    .filter((r): r is PromiseFulfilledResult<{ topic: string; shopify_webhook_id: string }> =>
      r.status === "fulfilled"
    )
    .map(r => ({
      store_id:           storeId,
      organization_id:    orgId,
      topic:              r.value.topic,
      shopify_webhook_id: r.value.shopify_webhook_id,
      address:            webhookEndpoint,
    }));

  // Log any registration failures (non-fatal — webhook can be re-registered later)
  for (const r of registrationResults) {
    if (r.status === "rejected") {
      console.error("registerWebhooks: failed to register webhook:", r.reason);
    }
  }

  // 5. Upsert all entries into shopify_webhook_subscriptions
  const allEntries = [...existingEntries, ...newEntries];
  if (allEntries.length > 0) {
    const { error: subErr } = await supabaseAdmin
      .from("shopify_webhook_subscriptions")
      .upsert(allEntries, { onConflict: "store_id,topic" });

    if (subErr) {
      console.error("registerWebhooks: DB upsert error:", subErr.message);
    } else {
      console.log(
        `registerWebhooks: ${newEntries.length} registered, ` +
        `${existingEntries.length} already existed for ${shopDomain}`
      );
    }
  }
}
