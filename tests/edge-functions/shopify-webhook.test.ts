/**
 * Edge Function tests: shopify-webhook
 *
 * Run with Deno: deno test tests/edge-functions/shopify-webhook.test.ts --allow-env --allow-net
 *
 * Tests HMAC verification, topic routing, and handler behaviors without
 * importing the actual edge function (Deno URL imports are unavailable in CI).
 * Instead, we test against the deployed local Supabase edge function via HTTP.
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.211.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const SUPABASE_URL       = Deno.env.get("SUPABASE_URL")        ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SHOPIFY_SECRET     = Deno.env.get("SHOPIFY_CLIENT_SECRET") ?? "test-shopify-secret";
const WEBHOOK_ENDPOINT   = `${SUPABASE_URL}/functions/v1/shopify-webhook`;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ── HMAC helper (mirrors edge function) ─────────────────────────────────────

async function signBody(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SHOPIFY_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// ── Test data ────────────────────────────────────────────────────────────────

const TEST_SHOP  = `deno-test-${Date.now()}.myshopify.com`;
let storeId      = "";
let orgId        = "";

// ── Setup / Teardown ─────────────────────────────────────────────────────────

async function setup() {
  // Create a minimal org and store via service role
  const { data: orgData } = await admin.rpc("create_organization_as_service", {
    org_name: "Webhook Test Org",
  }).single() as any;

  // Fallback: insert directly
  if (!orgData) {
    const { data: org } = await admin
      .from("organizations")
      .insert({ name: "Webhook Test Org", slug: `webhook-test-${Date.now()}` })
      .select("id")
      .single();
    orgId = org!.id;
  } else {
    orgId = orgData;
  }

  const { data: store } = await admin
    .from("shopify_stores")
    .insert({
      organization_id: orgId,
      shop_domain:     TEST_SHOP,
      shop_name:       "Webhook Test Store",
      access_token:    "test-access-token",
      scopes:          "read_orders,write_orders",
      connected_at:    new Date().toISOString(),
      status:          "active",
      is_active:       true,
    })
    .select("id")
    .single();
  storeId = store!.id;
}

async function teardown() {
  if (orgId) {
    await admin.from("organizations").delete().eq("id", orgId);
  }
}

// ── HMAC verification ────────────────────────────────────────────────────────

Deno.test({
  name: "rejects request with no HMAC header",
  async fn() {
    const body = JSON.stringify({ shop: TEST_SHOP });
    const res  = await fetch(WEBHOOK_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type":     "application/json",
        "X-Shopify-Topic":  "orders/create",
        "X-Shopify-Domain": TEST_SHOP,
      },
      body,
    });
    assertEquals(res.status, 401);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "rejects request with invalid HMAC",
  async fn() {
    const body = JSON.stringify({ shop: TEST_SHOP });
    const res  = await fetch(WEBHOOK_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type":                 "application/json",
        "X-Shopify-Topic":              "orders/create",
        "X-Shopify-Domain":             TEST_SHOP,
        "X-Shopify-Hmac-Sha256":        "bm90YXZhbGlkc2lnbmF0dXJl", // "notavalidsignature" in base64
      },
      body,
    });
    assertEquals(res.status, 401);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "accepts request with valid HMAC",
  async fn() {
    await setup();
    try {
      const body = JSON.stringify({
        shop: TEST_SHOP,
        id:   99999,
        email: "test@example.com",
        order_number: 1001,
        financial_status: "paid",
        total_price: "49.99",
        subtotal_price: "49.99",
        total_tax: "0.00",
        currency: "USD",
        line_items: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      const hmac = await signBody(body);
      const res  = await fetch(WEBHOOK_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type":          "application/json",
          "X-Shopify-Topic":       "orders/create",
          "X-Shopify-Domain":      TEST_SHOP,
          "X-Shopify-Hmac-Sha256": hmac,
        },
        body,
      });
      // 200 or 201 means HMAC passed; 4xx means HMAC failed
      assertEquals(res.status < 400, true, `Expected 2xx, got ${res.status}`);
    } finally {
      await teardown();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── app/uninstalled ──────────────────────────────────────────────────────────

Deno.test({
  name: "app/uninstalled marks store as disconnected",
  async fn() {
    await setup();
    try {
      const body = JSON.stringify({ shop: TEST_SHOP });
      const hmac = await signBody(body);

      const res = await fetch(WEBHOOK_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type":          "application/json",
          "X-Shopify-Topic":       "app/uninstalled",
          "X-Shopify-Domain":      TEST_SHOP,
          "X-Shopify-Hmac-Sha256": hmac,
        },
        body,
      });
      assertEquals(res.status, 200);

      // Verify store marked as disconnected
      const { data: store } = await admin
        .from("shopify_stores")
        .select("status, is_active")
        .eq("id", storeId)
        .single();

      assertEquals(store?.status, "disconnected");
      assertEquals(store?.is_active, false);
    } finally {
      await teardown();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── orders/create ────────────────────────────────────────────────────────────

Deno.test({
  name: "orders/create saves order to shopify_orders",
  async fn() {
    await setup();
    try {
      const shopifyOrderId = `test-order-${Date.now()}`;
      const body = JSON.stringify({
        shop: TEST_SHOP,
        id:   shopifyOrderId,
        order_number:     2001,
        email:            "customer@example.com",
        financial_status: "paid",
        fulfillment_status: null,
        total_price:      "99.99",
        subtotal_price:   "89.99",
        total_tax:        "10.00",
        currency:         "USD",
        line_items:       [{ id: 1, title: "Widget" }, { id: 2, title: "Gadget" }],
        tags:             "vip,repeat",
        source_name:      "web",
        created_at:       new Date().toISOString(),
        updated_at:       new Date().toISOString(),
        processed_at:     new Date().toISOString(),
        cancelled_at:     null,
      });
      const hmac = await signBody(body);

      const res = await fetch(WEBHOOK_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type":          "application/json",
          "X-Shopify-Topic":       "orders/create",
          "X-Shopify-Domain":      TEST_SHOP,
          "X-Shopify-Hmac-Sha256": hmac,
        },
        body,
      });
      assertEquals(res.status, 200);

      const { data: order } = await admin
        .from("shopify_orders")
        .select("*")
        .eq("store_id", storeId)
        .eq("shopify_order_id", shopifyOrderId)
        .single();

      assertExists(order);
      assertEquals(order.order_number, 2001);
      assertEquals(order.email, "customer@example.com");
      assertEquals(order.financial_status, "paid");
      assertEquals(Number(order.total_price), 99.99);
      assertEquals(order.line_items_count, 2);
      assertEquals(order.currency, "USD");
    } finally {
      await teardown();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── orders/updated ───────────────────────────────────────────────────────────

Deno.test({
  name: "orders/updated upserts the order record",
  async fn() {
    await setup();
    try {
      const shopifyOrderId = `update-order-${Date.now()}`;

      // Insert initial order
      await admin.from("shopify_orders").insert({
        store_id:          storeId,
        organization_id:   orgId,
        shopify_order_id:  shopifyOrderId,
        order_number:      3001,
        financial_status:  "pending",
        total_price:       50.00,
        currency:          "USD",
        created_at_shopify: new Date().toISOString(),
      });

      const body = JSON.stringify({
        shop: TEST_SHOP,
        id:   shopifyOrderId,
        order_number:     3001,
        financial_status: "paid",
        total_price:      "50.00",
        currency:         "USD",
        line_items:       [],
        created_at:       new Date().toISOString(),
        updated_at:       new Date().toISOString(),
      });
      const hmac = await signBody(body);

      const res = await fetch(WEBHOOK_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type":          "application/json",
          "X-Shopify-Topic":       "orders/updated",
          "X-Shopify-Domain":      TEST_SHOP,
          "X-Shopify-Hmac-Sha256": hmac,
        },
        body,
      });
      assertEquals(res.status, 200);

      const { data: order } = await admin
        .from("shopify_orders")
        .select("financial_status")
        .eq("store_id", storeId)
        .eq("shopify_order_id", shopifyOrderId)
        .single();

      assertEquals(order?.financial_status, "paid");
    } finally {
      await teardown();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── customers/redact ─────────────────────────────────────────────────────────

Deno.test({
  name: "customers/redact nullifies PII on matching orders",
  async fn() {
    await setup();
    try {
      const shopifyOrderId = `redact-order-${Date.now()}`;
      await admin.from("shopify_orders").insert({
        store_id:          storeId,
        organization_id:   orgId,
        shopify_order_id:  shopifyOrderId,
        order_number:      4001,
        email:             "pii@example.com",
        financial_status:  "paid",
        total_price:       20.00,
        currency:          "USD",
        raw_data:          { sensitive: "data" },
        created_at_shopify: new Date().toISOString(),
      });

      const body = JSON.stringify({
        shop:               TEST_SHOP,
        customer:           { id: 42, email: "pii@example.com" },
        orders_to_redact:   [{ id: shopifyOrderId }],
      });
      const hmac = await signBody(body);

      const res = await fetch(WEBHOOK_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type":          "application/json",
          "X-Shopify-Topic":       "customers/redact",
          "X-Shopify-Domain":      TEST_SHOP,
          "X-Shopify-Hmac-Sha256": hmac,
        },
        body,
      });
      assertEquals(res.status, 200);

      const { data: order } = await admin
        .from("shopify_orders")
        .select("email, raw_data")
        .eq("shopify_order_id", shopifyOrderId)
        .single();

      assertEquals(order?.email, null);
      assertEquals(order?.raw_data, null);
    } finally {
      await teardown();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── customers/data_request ───────────────────────────────────────────────────

Deno.test({
  name: "customers/data_request returns 200 (GDPR acknowledgment)",
  async fn() {
    await setup();
    try {
      const body = JSON.stringify({
        shop:     TEST_SHOP,
        customer: { id: 99, email: "gdpr@example.com" },
        orders_requested: [{ id: "ord-1" }],
      });
      const hmac = await signBody(body);

      const res = await fetch(WEBHOOK_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type":          "application/json",
          "X-Shopify-Topic":       "customers/data_request",
          "X-Shopify-Domain":      TEST_SHOP,
          "X-Shopify-Hmac-Sha256": hmac,
        },
        body,
      });
      assertEquals(res.status, 200);
    } finally {
      await teardown();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── shop/redact ──────────────────────────────────────────────────────────────

Deno.test({
  name: "shop/redact deletes all orders and redacts token",
  async fn() {
    await setup();
    try {
      // Pre-insert two orders
      await admin.from("shopify_orders").insert([
        {
          store_id: storeId, organization_id: orgId,
          shopify_order_id: `shop-redact-1-${Date.now()}`,
          order_number: 5001, financial_status: "paid",
          total_price: 10.00, currency: "USD",
          created_at_shopify: new Date().toISOString(),
        },
        {
          store_id: storeId, organization_id: orgId,
          shopify_order_id: `shop-redact-2-${Date.now()}`,
          order_number: 5002, financial_status: "refunded",
          total_price: 5.00, currency: "USD",
          created_at_shopify: new Date().toISOString(),
        },
      ]);

      const body = JSON.stringify({ shop: TEST_SHOP });
      const hmac = await signBody(body);

      const res = await fetch(WEBHOOK_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type":          "application/json",
          "X-Shopify-Topic":       "shop/redact",
          "X-Shopify-Domain":      TEST_SHOP,
          "X-Shopify-Hmac-Sha256": hmac,
        },
        body,
      });
      assertEquals(res.status, 200);

      const { data: orders } = await admin
        .from("shopify_orders")
        .select("id")
        .eq("store_id", storeId);
      assertEquals(orders?.length ?? 0, 0);

      const { data: store } = await admin
        .from("shopify_stores")
        .select("access_token")
        .eq("id", storeId)
        .single();
      assertEquals(store?.access_token, "[REDACTED]");
    } finally {
      await teardown();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
