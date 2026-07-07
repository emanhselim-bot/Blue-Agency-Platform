/**
 * Static test fixtures — constants reused across test files.
 * Secrets here are for local testing only; never commit real credentials.
 */

// ── HMAC / Crypto fixtures ────────────────────────────────────────────────────
export const TEST_SHOPIFY_SECRET = "test_shopify_client_secret_exactly_32c";
export const TEST_JWT_SECRET     = "test-jwt-secret-at-least-32-chars-long!!";
export const TEST_META_APP_ID    = "123456789";
export const TEST_META_APP_SECRET = "test_meta_app_secret_value_here12345";

// ── Shopify webhook fixtures ──────────────────────────────────────────────────
export const SHOPIFY_SHOP_DOMAIN = "test-store.myshopify.com";

/** A minimal valid Shopify order payload (subset of real structure) */
export const SHOPIFY_ORDER_PAYLOAD = {
  id:                 5678901234,
  order_number:       1001,
  email:              "customer@example.com",
  financial_status:   "paid",
  fulfillment_status: null,
  total_price:        "149.99",
  subtotal_price:     "139.99",
  total_tax:          "10.00",
  currency:           "USD",
  tags:               "vip",
  source_name:        "web",
  created_at:         "2024-01-15T10:00:00Z",
  updated_at:         "2024-01-15T10:05:00Z",
  processed_at:       "2024-01-15T10:00:00Z",
  cancelled_at:       null,
  line_items: [
    { id: 111, title: "Test Product", quantity: 2, price: "69.99" },
  ],
};

/** Minimal app/uninstalled payload */
export const SHOPIFY_UNINSTALL_PAYLOAD = {
  id:       11223344,
  name:     "Test Store",
  myshopify_domain: SHOPIFY_SHOP_DOMAIN,
};

/** Minimal customers/data_request payload */
export const SHOPIFY_DATA_REQUEST_PAYLOAD = {
  shop_id:    11223344,
  shop_domain: SHOPIFY_SHOP_DOMAIN,
  customer: {
    id:    9988776655,
    email: "customer@example.com",
    phone: null,
  },
  orders_requested: [5678901234],
  data_request: { id: 1 },
};

/** Minimal customers/redact payload */
export const SHOPIFY_CUSTOMERS_REDACT_PAYLOAD = {
  shop_id:    11223344,
  shop_domain: SHOPIFY_SHOP_DOMAIN,
  customer: {
    id:    9988776655,
    email: "customer@example.com",
  },
  orders_to_redact: [{ id: 5678901234, name: "#1001" }],
};

/** Minimal shop/redact payload */
export const SHOPIFY_SHOP_REDACT_PAYLOAD = {
  shop_id:    11223344,
  shop_domain: SHOPIFY_SHOP_DOMAIN,
};

// ── Meta fixtures ─────────────────────────────────────────────────────────────
export const META_BUSINESS_ID   = "bm_test_12345";
export const META_AD_ACCOUNT_ID = "act_test_67890";

/** A mock Meta insights response (account level) */
export const META_INSIGHTS_RESPONSE = {
  data: [{
    account_name:  "Test Ad Account",
    spend:         "1234.56",
    impressions:   "50000",
    reach:         "40000",
    clicks:        "2500",
    cpm:           "24.69",
    cpc:           "0.49",
    ctr:           "5.00",
    frequency:     "1.25",
    actions:       [{ action_type: "link_click", value: "2500" }],
    cost_per_action_type: [{ action_type: "link_click", value: "0.49" }],
    date_start:    "2024-01-01",
    date_stop:     "2024-01-31",
  }],
  paging: {},
};

/** Mock Meta error 190 (expired token) */
export const META_TOKEN_EXPIRED_RESPONSE = {
  error: {
    message:    "Error validating access token",
    type:       "OAuthException",
    code:       190,
    error_subcode: 463,
    fbtrace_id: "AbcDef123",
  },
};

// ── Organization fixtures ─────────────────────────────────────────────────────
export const TEST_ORG_NAME = "Test Agency";

// ── Auth fixtures ─────────────────────────────────────────────────────────────
export const VALID_PASSWORD   = "TestPassword1234!";
export const INVALID_PASSWORD = "wrong";

// ── RLS test org slugs (used to avoid name collisions) ───────────────────────
export const RLS_TEST_ORG_PREFIX = "rls-test-org-";
