/**
 * Shopify Session Exchange — Supabase Edge Function
 *
 * Receives an App Bridge session token (JWT) from an embedded Shopify app,
 * verifies it using SHOPIFY_CLIENT_SECRET, looks up the store owner in Blue Ad,
 * and returns a Supabase one-time token so the frontend can sign in without a password.
 *
 * Flow:
 *   1. Dashboard detects ?shop=X&host=Y (Shopify Admin embed)
 *   2. Dashboard loads App Bridge, gets session token
 *   3. Dashboard POSTs { session_token } here (no auth required)
 *   4. We verify signature + extract shop domain
 *   5. We find the shop owner's Supabase user
 *   6. We return { token_hash, email } → dashboard calls verifyOtp()
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

/** Base64url → regular string */
function base64urlDecode(str: string): string {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  return atob(b64 + "=".repeat((4 - b64.length % 4) % 4));
}

/**
 * Verifies a Shopify App Bridge session token (JWT signed with HMAC-SHA256).
 * Returns decoded payload on success, null on failure.
 */
async function verifyShopifyToken(
  token: string,
  clientSecret: string
): Promise<{ dest?: string; aud?: string; sub?: string; exp?: number } | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, sigB64] = parts;
    const message = `${headerB64}.${payloadB64}`;

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(clientSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const sigBytes = Uint8Array.from(
      atob(sigB64.replace(/-/g, "+").replace(/_/g, "/")),
      c => c.charCodeAt(0)
    );

    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      new TextEncoder().encode(message)
    );

    if (!valid) {
      console.warn("[shopify-session-exchange] Invalid token signature");
      return null;
    }

    const payload = JSON.parse(base64urlDecode(payloadB64));

    // Check expiry
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      console.warn("[shopify-session-exchange] Token expired");
      return null;
    }

    return payload;
  } catch (e) {
    console.error("[shopify-session-exchange] Token verification error:", e);
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // Parse body
  let body: { session_token?: string };
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "Invalid JSON" }, 400); }

  const { session_token } = body;
  if (!session_token) return jsonResponse({ error: "session_token required" }, 400);

  const clientSecret = Deno.env.get("SHOPIFY_CLIENT_SECRET");
  if (!clientSecret) {
    console.error("[shopify-session-exchange] SHOPIFY_CLIENT_SECRET not set");
    return jsonResponse({ error: "Server configuration error" }, 500);
  }

  // Verify the App Bridge session token
  const claims = await verifyShopifyToken(session_token, clientSecret);
  if (!claims) return jsonResponse({ error: "Invalid or expired session token" }, 401);

  // Extract shop domain from `dest` claim (e.g. "https://store.myshopify.com")
  const shopDomain = claims.dest?.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!shopDomain) return jsonResponse({ error: "No shop domain in token" }, 400);

  console.log("[shopify-session-exchange] Authenticated shop:", shopDomain);

  // Look up the store in Blue Ad
  const { data: store, error: storeErr } = await supabaseAdmin
    .from("shopify_stores")
    .select("organization_id, shop_domain")
    .eq("shop_domain", shopDomain)
    .single();

  if (storeErr || !store) {
    console.warn("[shopify-session-exchange] Store not found:", shopDomain);
    return jsonResponse({ error: "Store not connected to Blue Ad" }, 404);
  }

  // Get the organization owner
  const { data: member, error: memberErr } = await supabaseAdmin
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", store.organization_id)
    .eq("role", "owner")
    .not("accepted_at", "is", null)
    .single();

  if (memberErr || !member) {
    console.warn("[shopify-session-exchange] No owner found for org:", store.organization_id);
    return jsonResponse({ error: "No owner found for this store" }, 404);
  }

  // Fetch the user record
  const { data: { user }, error: userErr } = await supabaseAdmin.auth.admin.getUserById(member.user_id);
  if (userErr || !user?.email) {
    console.error("[shopify-session-exchange] User not found:", member.user_id);
    return jsonResponse({ error: "User not found" }, 404);
  }

  // Generate a one-time magic link token
  const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
    type: "magiclink",
    email: user.email,
  });

  if (linkErr || !linkData?.properties?.hashed_token) {
    console.error("[shopify-session-exchange] generateLink error:", linkErr);
    return jsonResponse({ error: "Failed to generate login token" }, 500);
  }

  console.log("[shopify-session-exchange] Auto-login token issued for:", user.email);

  return jsonResponse({
    token_hash: linkData.properties.hashed_token,
    email: user.email,
    shop: shopDomain,
  });
});
