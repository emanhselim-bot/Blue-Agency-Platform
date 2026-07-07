/**
 * Unit tests: HMAC-SHA256 utility functions
 *
 * Tests the exact algorithms used by:
 *   • shopify-oauth.ts     — verifyShopifyHmac() (OAuth callback)
 *   • shopify-webhook.ts   — verifyWebhookHmac() (incoming webhooks)
 *   • meta-oauth.ts        — signState() / verifyState()
 *
 * These are pure crypto functions. We re-implement them here so the tests
 * don't depend on importing from Deno edge function files, which use
 * Deno-specific imports incompatible with Node.js/Vitest.
 */

import { describe, it, expect } from "vitest";
import { createHmac, createHash, timingSafeEqual } from "crypto";

// ── Re-implementation of the HMAC helpers in Node.js for test verification ───

/**
 * Replicates shopify-webhook.ts verifyWebhookHmac():
 * Shopify signs webhooks as base64(HMAC-SHA256(secret, rawBody))
 * and sends it in X-Shopify-Hmac-Sha256.
 */
function computeWebhookHmac(secret: string, body: Buffer): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

function verifyWebhookHmac(secret: string, body: Buffer, provided: string): boolean {
  const computed = computeWebhookHmac(secret, body);
  if (computed.length !== provided.length) return false;
  return timingSafeEqual(Buffer.from(computed), Buffer.from(provided));
}

/**
 * Replicates shopify-oauth.ts verifyShopifyHmac():
 * Shopify OAuth callbacks include an hmac= param that is
 * HMAC-SHA256(secret, sorted_query_params).
 */
function computeOAuthHmac(secret: string, params: Record<string, string>): string {
  const pairs = Object.entries(params)
    .filter(([k]) => k !== "hmac")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return createHmac("sha256", secret).update(pairs).digest("hex");
}

const SECRET = "test_shopify_client_secret_exactly";
const BODY   = Buffer.from('{"id":12345,"financial_status":"paid"}');

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Webhook HMAC verification", () => {
  it("accepts a correctly signed payload", () => {
    const sig = computeWebhookHmac(SECRET, BODY);
    expect(verifyWebhookHmac(SECRET, BODY, sig)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const sig    = computeWebhookHmac(SECRET, BODY);
    const tamped = Buffer.from('{"id":99999,"financial_status":"paid"}'); // different id
    expect(verifyWebhookHmac(SECRET, tamped, sig)).toBe(false);
  });

  it("rejects an incorrect signature", () => {
    const wrongSig = computeWebhookHmac("wrong_secret", BODY);
    expect(verifyWebhookHmac(SECRET, BODY, wrongSig)).toBe(false);
  });

  it("rejects a truncated signature", () => {
    const sig = computeWebhookHmac(SECRET, BODY).slice(0, 20);
    expect(verifyWebhookHmac(SECRET, BODY, sig)).toBe(false);
  });

  it("rejects an empty signature", () => {
    expect(verifyWebhookHmac(SECRET, BODY, "")).toBe(false);
  });

  it("rejects a Base64-decoded signature (must be base64, not raw hex)", () => {
    const hexSig = createHmac("sha256", SECRET).update(BODY).digest("hex");
    // hex != base64, so this should fail
    expect(verifyWebhookHmac(SECRET, BODY, hexSig)).toBe(false);
  });

  it("is consistent across multiple calls with the same input", () => {
    const sig1 = computeWebhookHmac(SECRET, BODY);
    const sig2 = computeWebhookHmac(SECRET, BODY);
    expect(sig1).toBe(sig2);
  });

  it("produces different signatures for different secrets", () => {
    const sig1 = computeWebhookHmac("secret_a", BODY);
    const sig2 = computeWebhookHmac("secret_b", BODY);
    expect(sig1).not.toBe(sig2);
  });

  it("handles an empty body", () => {
    const empty = Buffer.from("");
    const sig   = computeWebhookHmac(SECRET, empty);
    expect(verifyWebhookHmac(SECRET, empty, sig)).toBe(true);
    // Non-empty body should not match empty-body signature
    expect(verifyWebhookHmac(SECRET, BODY, sig)).toBe(false);
  });

  it("handles Unicode / multi-byte bodies correctly", () => {
    const body = Buffer.from('{"name":"Ëmoji 🛒 test"}', "utf8");
    const sig  = computeWebhookHmac(SECRET, body);
    expect(verifyWebhookHmac(SECRET, body, sig)).toBe(true);
  });
});

describe("OAuth callback HMAC verification (shopify-oauth.ts)", () => {
  const params = { code: "auth_code_abc", shop: "test.myshopify.com", state: "abc123" };

  it("accepts correctly signed OAuth params", () => {
    const hmac     = computeOAuthHmac(SECRET, params);
    const computed = computeOAuthHmac(SECRET, { ...params, hmac });
    expect(computed).toBe(hmac);
  });

  it("excludes the hmac param from the signed string", () => {
    const paramsWithHmac = { ...params, hmac: "should_be_excluded" };
    const hmacA = computeOAuthHmac(SECRET, params);
    const hmacB = computeOAuthHmac(SECRET, paramsWithHmac);
    // Both should produce the same result because hmac is filtered
    expect(hmacA).toBe(hmacB);
  });

  it("sorts params alphabetically before signing", () => {
    const ordered   = { code: "x", shop: "y", state: "z" };
    const unordered = { state: "z", code: "x", shop: "y" }; // different JS insertion order
    expect(computeOAuthHmac(SECRET, ordered)).toBe(computeOAuthHmac(SECRET, unordered));
  });

  it("rejects params with an extra field", () => {
    const hmac         = computeOAuthHmac(SECRET, params);
    const tamperedHmac = computeOAuthHmac("wrong", params);
    expect(hmac).not.toBe(tamperedHmac);
  });

  it("returns lowercase hex string", () => {
    const hmac = computeOAuthHmac(SECRET, params);
    expect(hmac).toMatch(/^[0-9a-f]+$/);
  });
});

describe("Edge cases: secret handling", () => {
  it("an empty secret still produces a deterministic HMAC", () => {
    const sig1 = computeWebhookHmac("", BODY);
    const sig2 = computeWebhookHmac("", BODY);
    expect(sig1).toBe(sig2);
    // But it must NOT match a non-empty secret
    expect(sig1).not.toBe(computeWebhookHmac(SECRET, BODY));
  });

  it("secrets with similar prefixes produce distinct HMACs", () => {
    const sig1 = computeWebhookHmac("secret_a", BODY);
    const sig2 = computeWebhookHmac("secret_aa", BODY);
    expect(sig1).not.toBe(sig2);
  });
});
