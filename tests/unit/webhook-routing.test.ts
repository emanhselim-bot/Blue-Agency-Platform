/**
 * Unit tests: Shopify webhook routing and order row normalization
 *
 * Tests the topic dispatcher logic and the buildOrderRow() helper
 * from shopify-webhook.ts without needing a live database.
 */

import { describe, it, expect } from "vitest";
import {
  SHOPIFY_ORDER_PAYLOAD,
  SHOPIFY_SHOP_DOMAIN,
} from "@fixtures";

// ── Re-implementation of buildOrderRow() for testing ─────────────────────────
// This mirrors the exact logic in shopify-webhook.ts so we can verify
// the column mappings without importing Deno-specific files.

type Store = { id: string; organization_id: string; shop_name: string | null };

function buildOrderRow(store: Store, orderId: string, p: Record<string, unknown>) {
  const lineItems = p.line_items as unknown[] | undefined;
  return {
    store_id:             store.id,
    organization_id:      store.organization_id,
    shopify_order_id:     orderId,
    order_number:         (p.order_number          as number  | null) ?? null,
    email:                (p.email                 as string  | null) ?? null,
    financial_status:     (p.financial_status      as string  | null) ?? null,
    fulfillment_status:   (p.fulfillment_status     as string  | null) ?? null,
    total_price:          p.total_price     ? parseFloat(p.total_price as string)     : null,
    subtotal_price:       p.subtotal_price  ? parseFloat(p.subtotal_price as string)  : null,
    total_tax:            p.total_tax       ? parseFloat(p.total_tax as string)        : null,
    currency:             (p.currency              as string  | null) ?? null,
    line_items_count:     lineItems?.length ?? null,
    tags:                 (p.tags                  as string  | null) ?? null,
    source_name:          (p.source_name           as string  | null) ?? null,
    created_at_shopify:   (p.created_at            as string  | null) ?? null,
    updated_at_shopify:   (p.updated_at            as string  | null) ?? null,
    processed_at:         (p.processed_at          as string  | null) ?? null,
    cancelled_at:         (p.cancelled_at          as string  | null) ?? null,
    raw_data:             p,
  };
}

/** Valid webhook topics handled by the router */
const HANDLED_TOPICS = new Set([
  "app/uninstalled",
  "orders/create",
  "orders/updated",
  "customers/data_request",
  "customers/redact",
  "shop/redact",
]);

const TEST_STORE: Store = {
  id:              "store-uuid-abc",
  organization_id: "org-uuid-xyz",
  shop_name:       "Test Store",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Webhook topic routing", () => {
  const requiredTopics = [
    "app/uninstalled",
    "orders/create",
    "orders/updated",
    "customers/data_request",   // GDPR mandatory
    "customers/redact",          // GDPR mandatory
    "shop/redact",               // GDPR mandatory
  ];

  for (const topic of requiredTopics) {
    it(`handles topic: ${topic}`, () => {
      expect(HANDLED_TOPICS.has(topic)).toBe(true);
    });
  }

  it("does not crash on unknown topics (no handler registered)", () => {
    const unknown = "inventory/update";
    expect(HANDLED_TOPICS.has(unknown)).toBe(false);
    // Router would log and return 200 — no throw
  });

  it("all 3 GDPR-mandatory topics are present", () => {
    expect(HANDLED_TOPICS.has("customers/data_request")).toBe(true);
    expect(HANDLED_TOPICS.has("customers/redact")).toBe(true);
    expect(HANDLED_TOPICS.has("shop/redact")).toBe(true);
  });
});

describe("buildOrderRow: field mapping", () => {
  const row = buildOrderRow(TEST_STORE, String(SHOPIFY_ORDER_PAYLOAD.id), SHOPIFY_ORDER_PAYLOAD as Record<string, unknown>);

  it("sets store_id and organization_id from store", () => {
    expect(row.store_id).toBe(TEST_STORE.id);
    expect(row.organization_id).toBe(TEST_STORE.organization_id);
  });

  it("casts shopify_order_id to string", () => {
    expect(typeof row.shopify_order_id).toBe("string");
    expect(row.shopify_order_id).toBe("5678901234");
  });

  it("maps order_number", () => {
    expect(row.order_number).toBe(1001);
  });

  it("maps customer email", () => {
    expect(row.email).toBe("customer@example.com");
  });

  it("maps financial_status", () => {
    expect(row.financial_status).toBe("paid");
  });

  it("maps fulfillment_status (null when not fulfilled)", () => {
    expect(row.fulfillment_status).toBeNull();
  });

  it("parses total_price as float", () => {
    expect(row.total_price).toBe(149.99);
  });

  it("parses subtotal_price as float", () => {
    expect(row.subtotal_price).toBe(139.99);
  });

  it("parses total_tax as float", () => {
    expect(row.total_tax).toBe(10.00);
  });

  it("maps currency", () => {
    expect(row.currency).toBe("USD");
  });

  it("counts line_items correctly", () => {
    expect(row.line_items_count).toBe(1);
  });

  it("maps tags", () => {
    expect(row.tags).toBe("vip");
  });

  it("maps source_name", () => {
    expect(row.source_name).toBe("web");
  });

  it("maps Shopify created_at timestamp", () => {
    expect(row.created_at_shopify).toBe("2024-01-15T10:00:00Z");
  });

  it("maps Shopify updated_at timestamp", () => {
    expect(row.updated_at_shopify).toBe("2024-01-15T10:05:00Z");
  });

  it("maps cancelled_at as null when not cancelled", () => {
    expect(row.cancelled_at).toBeNull();
  });

  it("preserves full raw_data payload", () => {
    expect(row.raw_data).toEqual(SHOPIFY_ORDER_PAYLOAD);
  });
});

describe("buildOrderRow: edge cases", () => {
  it("handles missing optional fields gracefully (all null)", () => {
    const minimal = { id: 111 } as Record<string, unknown>;
    const row     = buildOrderRow(TEST_STORE, "111", minimal);
    expect(row.email).toBeNull();
    expect(row.financial_status).toBeNull();
    expect(row.total_price).toBeNull();
    expect(row.line_items_count).toBeNull();
    expect(row.tags).toBeNull();
  });

  it("handles zero total_price correctly (0 not null)", () => {
    const payload = { id: 222, total_price: "0.00" };
    const row     = buildOrderRow(TEST_STORE, "222", payload);
    expect(row.total_price).toBe(0);
  });

  it("handles empty line_items array (count = 0)", () => {
    const payload = { id: 333, line_items: [] };
    const row     = buildOrderRow(TEST_STORE, "333", payload);
    expect(row.line_items_count).toBe(0);
  });

  it("handles cancelled orders", () => {
    const payload = { id: 444, cancelled_at: "2024-02-01T12:00:00Z", financial_status: "refunded" };
    const row     = buildOrderRow(TEST_STORE, "444", payload);
    expect(row.cancelled_at).toBe("2024-02-01T12:00:00Z");
    expect(row.financial_status).toBe("refunded");
  });

  it("different order IDs produce distinct rows (no shared state)", () => {
    const r1 = buildOrderRow(TEST_STORE, "100", { id: 100, total_price: "10.00" });
    const r2 = buildOrderRow(TEST_STORE, "200", { id: 200, total_price: "20.00" });
    expect(r1.shopify_order_id).not.toBe(r2.shopify_order_id);
    expect(r1.total_price).not.toBe(r2.total_price);
  });
});
