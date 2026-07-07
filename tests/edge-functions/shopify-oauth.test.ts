/**
 * Edge Function tests: shopify-oauth
 *
 * Run with Deno: deno test tests/edge-functions/shopify-oauth.test.ts --allow-env --allow-net
 *
 * Tests the OAuth initiation and callback flows by sending real HTTP requests
 * to the locally running edge function.
 */

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.211.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")             ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SHOPIFY_SECRET   = Deno.env.get("SHOPIFY_CLIENT_SECRET")     ?? "test-shopify-secret";
const OAUTH_ENDPOINT   = `${SUPABASE_URL}/functions/v1/shopify-oauth`;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ── HMAC helper (mirrors the callback verification in shopify-oauth.ts) ──────

async function hmacForParams(params: Record<string, string>): Promise<string> {
  const sorted = Object.keys(params)
    .filter((k) => k !== "hmac")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SHOPIFY_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(sorted));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Create a signed JWT for authenticated requests ───────────────────────────

async function getAnonJwt(): Promise<string> {
  // Use the anon key for unauthenticated flow testing;
  // real auth requires a signed-in user's JWT.
  return Deno.env.get("SUPABASE_ANON_KEY") ?? "";
}

// ── Tests ────────────────────────────────────────────────────────────────────

Deno.test({
  name: "GET /shopify-oauth without params returns 400",
  async fn() {
    const res = await fetch(OAUTH_ENDPOINT, { method: "GET" });
    // Missing shop or org_id → bad request
    assertEquals(res.status >= 400, true, `Expected 4xx, got ${res.status}`);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "GET /shopify-oauth with shop redirects to Shopify OAuth",
  async fn() {
    const anon = await getAnonJwt();
    const url  = new URL(OAUTH_ENDPOINT);
    url.searchParams.set("shop", "test-store.myshopify.com");
    url.searchParams.set("org_id", "00000000-0000-0000-0000-000000000001");

    const res = await fetch(url.toString(), {
      method: "GET",
      redirect: "manual", // Don't follow redirect
      headers: { Authorization: `Bearer ${anon}` },
    });

    // Shopify OAuth initiation should redirect to myshopify.com/admin/oauth/authorize
    assertEquals([301, 302, 303].includes(res.status), true, `Expected redirect, got ${res.status}`);
    const location = res.headers.get("location") ?? "";
    assertStringIncludes(location, "myshopify.com");
    assertStringIncludes(location, "oauth/authorize");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "Callback with invalid HMAC returns 401",
  async fn() {
    const callbackUrl = new URL(`${OAUTH_ENDPOINT}/callback`);
    callbackUrl.searchParams.set("code",      "some-code");
    callbackUrl.searchParams.set("shop",      "test-store.myshopify.com");
    callbackUrl.searchParams.set("state",     "invalid-state");
    callbackUrl.searchParams.set("timestamp", String(Math.floor(Date.now() / 1000)));
    callbackUrl.searchParams.set("hmac",      "badhmacsignature");

    const res = await fetch(callbackUrl.toString(), {
      method: "GET",
      redirect: "manual",
    });

    assertEquals(res.status >= 400, true, `Expected 4xx, got ${res.status}`);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "Callback with valid HMAC but expired/invalid state returns 400",
  async fn() {
    const shop      = "test-store.myshopify.com";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const code      = "test-code-123";
    const state     = "invalid-state-that-cannot-be-verified";

    const params: Record<string, string> = { code, shop, state, timestamp };
    const hmac = await hmacForParams(params);
    params.hmac = hmac;

    const callbackUrl = new URL(`${OAUTH_ENDPOINT}/callback`);
    for (const [k, v] of Object.entries(params)) {
      callbackUrl.searchParams.set(k, v);
    }

    const res = await fetch(callbackUrl.toString(), {
      method: "GET",
      redirect: "manual",
    });

    // Valid HMAC passes signature check, but state verification should fail
    assertEquals(res.status >= 400, true, `Expected 4xx, got ${res.status}`);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "OPTIONS request returns CORS headers",
  async fn() {
    const res = await fetch(OAUTH_ENDPOINT, { method: "OPTIONS" });
    const allowOrigin = res.headers.get("access-control-allow-origin");
    assertEquals(allowOrigin !== null, true, "Should return CORS header");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "Shopify domain must end in .myshopify.com",
  async fn() {
    const anon = await getAnonJwt();
    const url  = new URL(OAUTH_ENDPOINT);
    url.searchParams.set("shop", "evil-phishing-site.example.com");
    url.searchParams.set("org_id", "00000000-0000-0000-0000-000000000001");

    const res = await fetch(url.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { Authorization: `Bearer ${anon}` },
    });

    // Should reject non-.myshopify.com domains
    assertEquals(res.status >= 400, true, `Expected 4xx, got ${res.status}`);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
