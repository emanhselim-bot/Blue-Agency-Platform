/**
 * Unit tests: State parameter signing & verification
 *
 * Tests the HMAC-signed state parameter used by both shopify-oauth.ts
 * and meta-oauth.ts to prevent CSRF in OAuth flows.
 *
 * Algorithm (re-implemented here for testing):
 *   state = base64(JSON(payload + exp)) + "." + HMAC-SHA256-hex(JWT_SECRET, payload_json)
 *
 * Verification checks:
 *   1. Split on "."
 *   2. base64-decode the first segment
 *   3. Compute HMAC of the decoded string and compare to the second segment
 *   4. Check the exp field hasn't passed
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createHmac, timingSafeEqual } from "crypto";

const SECRET = "test-jwt-secret-at-least-32-chars-long!!";

// ── Re-implementation of signState / verifyState (Node.js) ───────────────────

function signState(payload: object, secret: string, ttlMs = 600_000): string {
  const data   = JSON.stringify({ ...payload, exp: Date.now() + ttlMs });
  const sigHex = createHmac("sha256", secret).update(data).digest("hex");
  return Buffer.from(data).toString("base64") + "." + sigHex;
}

function verifyState(state: string, secret: string): Record<string, unknown> | null {
  const [b64, sigHex] = state.split(".");
  if (!b64 || !sigHex) return null;

  let data: string;
  try { data = Buffer.from(b64, "base64").toString("utf8"); }
  catch { return null; }

  const computedHex = createHmac("sha256", secret).update(data).digest("hex");

  // Constant-time compare
  if (computedHex.length !== sigHex.length) return null;
  if (!timingSafeEqual(Buffer.from(computedHex, "hex"), Buffer.from(sigHex, "hex"))) return null;

  const payload = JSON.parse(data);
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;

  return payload;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("State parameter signing", () => {
  it("produces a non-empty string", () => {
    const state = signState({ org_id: "org_1", user_id: "user_1" }, SECRET);
    expect(typeof state).toBe("string");
    expect(state.length).toBeGreaterThan(0);
  });

  it("contains exactly one dot separator", () => {
    const state = signState({ org_id: "org_1" }, SECRET);
    const dots  = (state.match(/\./g) ?? []).length;
    expect(dots).toBe(1);
  });

  it("embeds the payload in the base64 segment", () => {
    const state   = signState({ org_id: "org_abc" }, SECRET);
    const [b64]   = state.split(".");
    const decoded = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    expect(decoded.org_id).toBe("org_abc");
  });

  it("embeds an exp field in the future", () => {
    const before  = Date.now();
    const state   = signState({ x: 1 }, SECRET);
    const [b64]   = state.split(".");
    const decoded = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    expect(decoded.exp).toBeGreaterThan(before);
  });

  it("two calls with same payload produce different states (different exp)", async () => {
    const s1 = signState({ a: 1 }, SECRET);
    await new Promise(r => setTimeout(r, 2)); // ensure different ms
    const s2 = signState({ a: 1 }, SECRET);
    expect(s1).not.toBe(s2);
  });
});

describe("State parameter verification", () => {
  it("verifies a freshly signed state", () => {
    const state   = signState({ org_id: "org_1", user_id: "u1" }, SECRET);
    const payload = verifyState(state, SECRET);
    expect(payload).not.toBeNull();
    expect(payload?.org_id).toBe("org_1");
    expect(payload?.user_id).toBe("u1");
  });

  it("returns null for a wrong secret", () => {
    const state = signState({ org_id: "org_1" }, SECRET);
    expect(verifyState(state, "wrong-secret-entirely")).toBeNull();
  });

  it("returns null for a tampered payload", () => {
    const state    = signState({ org_id: "org_1" }, SECRET);
    const [b64, sig] = state.split(".");
    // Replace org_id with a different value
    const decoded  = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    decoded.org_id = "evil_org";
    const tamperedB64 = Buffer.from(JSON.stringify(decoded)).toString("base64");
    const tampered    = tamperedB64 + "." + sig;
    expect(verifyState(tampered, SECRET)).toBeNull();
  });

  it("returns null for a truncated state", () => {
    const state = signState({ org_id: "org_1" }, SECRET);
    expect(verifyState(state.slice(0, 20), SECRET)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(verifyState("", SECRET)).toBeNull();
  });

  it("returns null for a state missing the dot separator", () => {
    expect(verifyState("nodotsinhere", SECRET)).toBeNull();
  });

  it("returns null for an expired state", () => {
    // Sign with a negative TTL so it expires immediately
    const state = signState({ org_id: "org_1" }, SECRET, -1000);
    expect(verifyState(state, SECRET)).toBeNull();
  });

  it("returns null for a state that just expired", () => {
    const state = signState({ org_id: "org_1" }, SECRET, 0);
    // exp = now + 0 = now, which is already ≤ Date.now() when checked
    expect(verifyState(state, SECRET)).toBeNull();
  });

  it("preserves all payload fields through sign → verify", () => {
    const payload = { org_id: "org_abc", user_id: "user_xyz", shop: "store.myshopify.com" };
    const state   = signState(payload, SECRET);
    const result  = verifyState(state, SECRET);
    expect(result?.org_id).toBe(payload.org_id);
    expect(result?.user_id).toBe(payload.user_id);
    expect(result?.shop).toBe(payload.shop);
  });

  it("rejects a state signed with the same algorithm but a different key length", () => {
    const shortSecret = "short";
    const state       = signState({ org_id: "org_1" }, shortSecret);
    expect(verifyState(state, SECRET)).toBeNull();
  });
});

describe("State replay protection", () => {
  it("a valid state cannot be used after expiry", async () => {
    const state = signState({ org_id: "org_1" }, SECRET, 50); // 50ms TTL
    expect(verifyState(state, SECRET)).not.toBeNull(); // valid immediately
    await new Promise(r => setTimeout(r, 60));           // wait for expiry
    expect(verifyState(state, SECRET)).toBeNull();
  });
});
