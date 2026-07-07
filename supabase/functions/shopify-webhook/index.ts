/**
 * Shopify Webhook Handler — Supabase Edge Function
 * Deploy: supabase functions deploy shopify-webhook
 *
 * Receives, verifies, and processes all Shopify webhook events for every
 * connected store in the platform. A single function handles all topics —
 * routing is done by the X-Shopify-Topic header.
 *
 * Topics handled:
 *   app/uninstalled        — Merchant removed the app. Mark store inactive.
 *   orders/create          — New order placed. Insert into shopify_orders.
 *   orders/updated         — Order changed. Upsert into shopify_orders.
 *   customers/data_request — GDPR: Customer requested their data. Log + ack.
 *   customers/redact       — GDPR: Remove customer PII from our orders table.
 *   shop/redact            — GDPR: Delete ALL shop data (48h after uninstall).
 *
 * Signature verification:
 *   Shopify signs every webhook with HMAC-SHA256 of the raw request body
 *   using SHOPIFY_CLIENT_SECRET as the key. The result is base64-encoded and
 *   sent in the X-Shopify-Hmac-Sha256 header. We read the raw bytes BEFORE
 *   any JSON parsing, compute the HMAC, and compare with constant-time logic
 *   to prevent timing-based oracle attacks. Invalid signatures → 401 before
 *   any DB operation runs.
 *
 * Shopify retry behavior:
 *   Shopify retries on any non-2xx response, with exponential backoff up to
 *   19 attempts over 48 hours. We always return 200 after HMAC passes —
 *   errors inside handlers are logged but don't cause retries (deterministic
 *   failures won't be fixed by retrying).
 *
 * Environment variables required (set via: supabase secrets set KEY=value):
 *   SHOPIFY_CLIENT_SECRET     — from Shopify Partner Dashboard
 *   SUPABASE_URL              — set automatically by Supabase
 *   SUPABASE_SERVICE_ROLE_KEY — set automatically by Supabase
 *
 * Registration:
 *   Webhooks are registered automatically by shopify-oauth.ts after each
 *   successful OAuth flow. The endpoint URL is:
 *   https://YOUR_PROJECT.supabase.co/functions/v1/shopify-webhook
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// ── HMAC signature verification ───────────────────────────────────────────────
// Shopify signs webhooks as: base64( HMAC-SHA256(SHOPIFY_CLIENT_SECRET, raw_body) )
// We MUST verify against the raw bytes — parsing and re-serializing JSON changes
// whitespace and can break the signature.
async function verifyWebhookHmac(
  rawBody: Uint8Array,
  providedBase64: string
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(Deno.env.get("SHOPIFY_CLIENT_SECRET")!),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, rawBody);
  // Convert to base64 manually (btoa + fromCharCode is safe for HMAC output)
  const computedBase64 = btoa(String.fromCharCode(...new Uint8Array(sig)));

  // Constant-time comparison — prevents timing oracle attacks
  if (computedBase64.length !== providedBase64.length) return false;
  let mismatch = 0;
  for (let i = 0; i < computedBase64.length; i++) {
    mismatch |= computedBase64.charCodeAt(i) ^ providedBase64.charCodeAt(i);
  }
  return mismatch === 0;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

type Store = { id: string; organization_id: string; shop_name: string | null };

async function findStore(shopDomain: string): Promise<Store | null> {
  const { data } = await supabaseAdmin
    .from("shopify_stores")
    .select("id, organization_id, shop_name")
    .eq("shop_domain", shopDomain)
    .single();
  return data ?? null;
}

async function writeAuditLog(
  organizationId: string | null,
  action: string,
  resourceType: string,
  resourceId: string | null,
  metadata: Record<string, unknown>
) {
  await supabaseAdmin.from("audit_log").insert({
    organization_id: organizationId ?? undefined,
    action,
    resource_type:   resourceType,
    resource_id:     resourceId ?? undefined,
    metadata,
  });
}

// ── Order row builder ─────────────────────────────────────────────────────────
// Normalizes a Shopify order payload into our shopify_orders schema.
function buildOrderRow(
  store: Store,
  orderId: string,
  p: Record<string, unknown>
) {
  const lineItems = p.line_items as unknown[] | undefined;
  return {
    store_id:             store.id,
    organization_id:      store.organization_id,
    shopify_order_id:     orderId,
    order_number:         (p.order_number         as number  | null) ?? null,
    email:                (p.email                as string  | null) ?? null,
    financial_status:     (p.financial_status     as string  | null) ?? null,
    fulfillment_status:   (p.fulfillment_status   as string  | null) ?? null,
    total_price:          p.total_price     ? parseFloat(p.total_price as string)     : null,
    subtotal_price:       p.subtotal_price  ? parseFloat(p.subtotal_price as string)  : null,
    total_tax:            p.total_tax       ? parseFloat(p.total_tax as string)        : null,
    currency:             (p.currency             as string  | null) ?? null,
    line_items_count:     lineItems?.length ?? null,
    tags:                 (p.tags                 as string  | null) ?? null,
    source_name:          (p.source_name          as string  | null) ?? null,
    created_at_shopify:   (p.created_at           as string  | null) ?? null,
    updated_at_shopify:   (p.updated_at           as string  | null) ?? null,
    processed_at:         (p.processed_at         as string  | null) ?? null,
    cancelled_at:         (p.cancelled_at         as string  | null) ?? null,
    raw_data:             p,
    updated_at:           new Date().toISOString(),
  };
}

// ── Topic handlers ────────────────────────────────────────────────────────────

// app/uninstalled
// Merchant removed the app from their store. The access token is now void.
// Mark the store inactive and remove tracked webhook subscriptions.
async function handleAppUninstalled(
  payload: Record<string, unknown>,
  shopDomain: string
) {
  const store = await findStore(shopDomain);
  if (!store) {
    console.warn(`app/uninstalled: no store found for ${shopDomain}`);
    return;
  }

  await supabaseAdmin
    .from("shopify_stores")
    .update({ status: "disconnected", is_active: false, updated_at: new Date().toISOString() })
    .eq("id", store.id);

  // Remove our webhook subscription records — they are now invalid
  await supabaseAdmin
    .from("shopify_webhook_subscriptions")
    .delete()
    .eq("store_id", store.id);

  await writeAuditLog(
    store.organization_id,
    "shopify.app.uninstalled",
    "shopify_store",
    store.id,
    { shop_domain: shopDomain, shop_name: (payload.name as string) ?? store.shop_name }
  );

  console.log(`app/uninstalled: marked ${shopDomain} as disconnected`);
}

// orders/create
// A new order was placed. Insert into shopify_orders.
async function handleOrderCreate(
  payload: Record<string, unknown>,
  shopDomain: string
) {
  const store = await findStore(shopDomain);
  if (!store) { console.warn(`orders/create: no store found for ${shopDomain}`); return; }

  const orderId = String(payload.id);
  const { error } = await supabaseAdmin
    .from("shopify_orders")
    .upsert(buildOrderRow(store, orderId, payload), { onConflict: "store_id,shopify_order_id" });

  if (error) {
    console.error(`orders/create: DB error for order ${orderId}:`, error.message);
    return;
  }

  await writeAuditLog(
    store.organization_id,
    "shopify.order.created",
    "shopify_order",
    null,
    { shop_domain: shopDomain, shopify_order_id: orderId, total_price: payload.total_price }
  );

  console.log(`orders/create: saved order ${orderId} for ${shopDomain}`);
}

// orders/updated
// An existing order changed status, was fulfilled, refunded, etc.
// Upsert so reconnected stores can backfill updates they missed.
async function handleOrderUpdated(
  payload: Record<string, unknown>,
  shopDomain: string
) {
  const store = await findStore(shopDomain);
  if (!store) { console.warn(`orders/updated: no store found for ${shopDomain}`); return; }

  const orderId = String(payload.id);
  const { error } = await supabaseAdmin
    .from("shopify_orders")
    .upsert(buildOrderRow(store, orderId, payload), { onConflict: "store_id,shopify_order_id" });

  if (error) {
    console.error(`orders/updated: DB error for order ${orderId}:`, error.message);
    return;
  }

  console.log(`orders/updated: upserted order ${orderId} for ${shopDomain}`);
}

// customers/data_request  (GDPR — MANDATORY for all Shopify apps)
// A customer requested a copy of all their data held by this app.
// Shopify requires a 200 acknowledgment. Log it so the merchant can respond.
async function handleCustomersDataRequest(
  payload: Record<string, unknown>,
  shopDomain: string
) {
  const store = await findStore(shopDomain);
  const customer     = payload.customer      as Record<string, unknown> | undefined;
  const dataRequest  = payload.data_request  as Record<string, unknown> | undefined;

  await writeAuditLog(
    store?.organization_id ?? null,
    "shopify.gdpr.data_request",
    "shopify_store",
    store?.id ?? null,
    {
      shop_domain:       shopDomain,
      customer_id:       customer?.id,
      customer_email:    customer?.email,
      data_request_id:   dataRequest?.id,
      orders_requested:  payload.orders_requested,
    }
  );

  console.log(
    `customers/data_request: logged for customer ${customer?.id} at ${shopDomain}`
  );
}

// customers/redact  (GDPR — MANDATORY for all Shopify apps)
// Remove all PII for the specified customer from our systems.
// For us: null out the email column on shopify_orders rows for affected orders.
// raw_data may also contain email — we null out raw_data for the affected rows.
async function handleCustomersRedact(
  payload: Record<string, unknown>,
  shopDomain: string
) {
  const store = await findStore(shopDomain);
  if (!store) { console.warn(`customers/redact: no store found for ${shopDomain}`); return; }

  const customer       = payload.customer       as Record<string, unknown> | undefined;
  const customerId     = customer?.id;
  const customerEmail  = customer?.email as string | undefined;
  const ordersToRedact = payload.orders_to_redact as Array<{ id: number }> | undefined;

  let redactedCount = 0;

  if (ordersToRedact?.length) {
    // Redact the specific orders Shopify told us about
    const shopifyIds = ordersToRedact.map(o => String(o.id));
    const { count } = await supabaseAdmin
      .from("shopify_orders")
      .update({ email: null, raw_data: null, updated_at: new Date().toISOString() })
      .eq("store_id", store.id)
      .in("shopify_order_id", shopifyIds);
    redactedCount = count ?? shopifyIds.length;
  } else if (customerEmail) {
    // Fallback: redact by email if Shopify didn't provide specific order IDs
    const { count } = await supabaseAdmin
      .from("shopify_orders")
      .update({ email: null, raw_data: null, updated_at: new Date().toISOString() })
      .eq("store_id", store.id)
      .eq("email", customerEmail);
    redactedCount = count ?? 0;
  }

  await writeAuditLog(
    store.organization_id,
    "shopify.gdpr.customers_redacted",
    "shopify_store",
    store.id,
    {
      shop_domain:      shopDomain,
      customer_id:      customerId,
      customer_email:   customerEmail,
      orders_redacted:  redactedCount,
    }
  );

  console.log(
    `customers/redact: redacted ${redactedCount} order(s) for customer ${customerId} at ${shopDomain}`
  );
}

// shop/redact  (GDPR — MANDATORY for all Shopify apps)
// Called 48 hours after app/uninstalled. Delete ALL data for this shop from
// our systems. By this point the store should already be inactive.
async function handleShopRedact(
  payload: Record<string, unknown>,
  shopDomain: string
) {
  // Use the raw service role query — store may already be marked disconnected
  const { data: store } = await supabaseAdmin
    .from("shopify_stores")
    .select("id, organization_id")
    .eq("shop_domain", shopDomain)
    .single();

  if (!store) {
    console.warn(`shop/redact: no store found for ${shopDomain} — may already have been purged`);
    return;
  }

  // 1. Delete all orders for this store
  await supabaseAdmin
    .from("shopify_orders")
    .delete()
    .eq("store_id", store.id);

  // 2. Delete tracked webhook subscriptions
  await supabaseAdmin
    .from("shopify_webhook_subscriptions")
    .delete()
    .eq("store_id", store.id);

  // 3. Nullify the access token (column is NOT NULL so use placeholder) and
  //    confirm the store is fully deactivated
  await supabaseAdmin
    .from("shopify_stores")
    .update({
      access_token: "[REDACTED]",
      status:       "disconnected",
      is_active:    false,
      updated_at:   new Date().toISOString(),
    })
    .eq("id", store.id);

  await writeAuditLog(
    store.organization_id,
    "shopify.gdpr.shop_redacted",
    "shopify_store",
    store.id,
    { shop_domain: shopDomain, shop_id: payload.shop_id }
  );

  console.log(`shop/redact: completed full data redaction for ${shopDomain}`);
}

// ── Main request handler ──────────────────────────────────────────────────────
serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // ── Step 1: Read the raw body as bytes BEFORE any parsing ──
  // JSON parsing changes whitespace and can break the Shopify HMAC.
  let rawBodyBytes: Uint8Array;
  try {
    rawBodyBytes = new Uint8Array(await req.arrayBuffer());
  } catch {
    return new Response("Cannot read body", { status: 400 });
  }

  // ── Step 2: Verify HMAC signature ──
  const providedHmac = req.headers.get("X-Shopify-Hmac-Sha256");
  if (!providedHmac) {
    console.warn("Webhook missing X-Shopify-Hmac-Sha256 header — rejected");
    return new Response("Unauthorized", { status: 401 });
  }
  if (!await verifyWebhookHmac(rawBodyBytes, providedHmac)) {
    console.warn("Webhook HMAC verification failed — rejected");
    return new Response("Unauthorized", { status: 401 });
  }

  // ── Step 3: Parse headers ──
  const topic      = req.headers.get("X-Shopify-Topic")       ?? "";
  const shopDomain = req.headers.get("X-Shopify-Shop-Domain") ?? "";

  if (!topic || !shopDomain) {
    return new Response("Missing required headers", { status: 400 });
  }

  // ── Step 4: Parse body ──
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBodyBytes));
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  console.log(`Webhook: ${topic} from ${shopDomain}`);

  // ── Step 5: Dispatch to handler ──
  // Always return 200 after HMAC passes. Handler errors are logged, not re-thrown.
  // Throwing here would cause Shopify to retry — for deterministic failures
  // (e.g., unknown shop) retries won't help and would flood logs.
  try {
    switch (topic) {
      case "app/uninstalled":        await handleAppUninstalled(payload, shopDomain);       break;
      case "orders/create":          await handleOrderCreate(payload, shopDomain);          break;
      case "orders/updated":         await handleOrderUpdated(payload, shopDomain);         break;
      case "customers/data_request": await handleCustomersDataRequest(payload, shopDomain); break;
      case "customers/redact":       await handleCustomersRedact(payload, shopDomain);      break;
      case "shop/redact":            await handleShopRedact(payload, shopDomain);           break;
      default:
        console.log(`Unhandled webhook topic: ${topic}`);
    }
  } catch (err) {
    console.error(`Unhandled error in webhook handler [${topic}] [${shopDomain}]:`, err);
    // Still return 200 — don't trigger Shopify retries for server-side errors
  }

  return new Response("OK", { status: 200 });
});
