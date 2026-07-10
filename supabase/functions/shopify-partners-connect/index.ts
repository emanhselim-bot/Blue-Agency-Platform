/**
 * shopify-partners-connect — Supabase Edge Function
 *
 * Connects a Shopify store using a direct Admin API token obtained from
 * the Shopify Partners Dashboard (via collaborator access + custom app).
 *
 * No OAuth redirect required — the agency creates the token themselves
 * in the Partners portal and pastes it here.
 *
 * POST body:
 *   { organization_id: string, shop_domain: string, access_token: string }
 *
 * Environment variables:
 *   SUPABASE_URL                — set automatically by Supabase
 *   SUPABASE_SERVICE_ROLE_KEY   — set automatically by Supabase
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Content-Type": "application/json",
};

// ── Shopify Admin GraphQL — fetch basic shop info to validate the token ──
async function fetchShopInfo(domain: string, token: string) {
  const raw = domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const myshopifyDomain = raw.includes(".")
    ? raw
    : `${raw}.myshopify.com`;

  const res = await fetch(
    `https://${myshopifyDomain}/admin/api/2024-07/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({
        query: `{
          shop {
            id
            name
            myshopifyDomain
            currencyCode
            ianaTimezone
            plan { displayName }
          }
        }`,
      }),
    }
  );

  if (!res.ok) {
    return { error: `Shopify returned HTTP ${res.status} — check the store domain` };
  }

  const json = await res.json();
  if (json.errors) {
    const msg = json.errors[0]?.message || "Shopify API error";
    // 401/403 usually means bad token
    if (msg.toLowerCase().includes("access denied") || msg.toLowerCase().includes("invalid")) {
      return { error: "Invalid access token — check the token and its API scopes" };
    }
    return { error: msg };
  }

  return { shop: json.data?.shop };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  // ── Auth: require a valid Supabase JWT ──
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace("Bearer ", "").trim();
  if (!jwt) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: CORS,
    });
  }

  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(jwt);
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: "Invalid token" }), {
      status: 401,
      headers: CORS,
    });
  }

  // ── Parse body ──
  let body: { organization_id?: string; shop_domain?: string; access_token?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: CORS,
    });
  }

  const { organization_id, shop_domain, access_token } = body;

  if (!organization_id || !shop_domain || !access_token) {
    return new Response(
      JSON.stringify({ error: "organization_id, shop_domain, and access_token are required" }),
      { status: 400, headers: CORS }
    );
  }

  // ── Verify user is a member of this org ──
  const { data: membership } = await supabaseAdmin
    .from("organization_members")
    .select("role")
    .eq("organization_id", organization_id)
    .eq("user_id", user.id)
    .single();

  if (!membership) {
    return new Response(JSON.stringify({ error: "Not a member of this organization" }), {
      status: 403,
      headers: CORS,
    });
  }

  // ── Validate the token by querying the Shopify Admin API ──
  const { shop, error: shopErr } = await fetchShopInfo(shop_domain, access_token);
  if (shopErr || !shop) {
    return new Response(
      JSON.stringify({ error: shopErr || "Could not fetch shop info — check the domain and token" }),
      { status: 422, headers: CORS }
    );
  }

  const myshopifyDomain = shop.myshopifyDomain as string;
  const shopName       = shop.name as string;
  const currency       = shop.currencyCode as string;
  const timezone       = shop.ianaTimezone as string;
  const planName       = (shop.plan as { displayName: string })?.displayName || null;
  // Strip "gid://shopify/Shop/" prefix from the GID
  const shopId         = (shop.id as string).replace("gid://shopify/Shop/", "");

  // ── Upsert store ──
  // access_token is stored in plaintext (same as shopify-oauth);
  // SELECT is revoked from authenticated users — only service role reads it.
  const { data: storeRow, error: upsertErr } = await supabaseAdmin
    .from("shopify_stores")
    .upsert(
      {
        organization_id,
        shop_domain:  myshopifyDomain,
        shop_name:    shopName,
        shop_id:      shopId,
        access_token,
        currency,
        timezone,
        plan_name:    planName,
        connected_by: user.id,
        status:       "active",
        is_active:    true,
        connected_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,shop_domain" }
    )
    .select("id, shop_domain, shop_name")
    .single();

  if (upsertErr) {
    console.error("upsert error:", upsertErr);
    return new Response(
      JSON.stringify({ error: "Database error: " + upsertErr.message }),
      { status: 500, headers: CORS }
    );
  }

  return new Response(
    JSON.stringify({
      success: true,
      store: storeRow,
      shop_name: shopName,
      currency,
    }),
    { status: 200, headers: CORS }
  );
});
