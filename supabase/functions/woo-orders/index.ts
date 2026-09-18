/**
 * WooCommerce orders -> site_events
 *
 * Two ways in, both writing the same 'purchase' row the dashboard already reads:
 *
 *  1. A WooCommerce webhook (order.created / order.updated), signed by
 *     WooCommerce with HMAC-SHA256 in X-WC-Webhook-Signature.
 *  2. A bulk import: { orders: [...] } with the shared secret in a header, for
 *     history that predates the webhook. Webhooks only ever fire forward.
 *
 * verify_jwt is off because WooCommerce cannot send a Supabase JWT. The
 * tracker's webhook_secret is what authorises a write, so the site key alone --
 * which is public, it sits in the page -- gets nothing.
 *
 * An order that is cancelled, failed or refunded is not revenue: its purchase
 * row is deleted rather than left behind, so a refunded sale stops counting the
 * moment the shop says so.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, apikey, x-wc-webhook-signature, x-bluead-secret",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const DEAD = new Set(["cancelled", "failed", "refunded", "trash", "checkout-draft"]);

function qtyOf(o: Record<string, unknown>): number {
  const items = (o.line_items as { quantity?: number }[]) ?? [];
  return items.reduce((s, li) => s + (Number(li.quantity) || 0), 0);
}

function whenOf(o: Record<string, unknown>): string {
  const g = (o.date_created_gmt as string) || "";
  if (g) return new Date(g.endsWith("Z") ? g : g + "Z").toISOString();
  const d = (o.date_created as string) || "";
  return d ? new Date(d).toISOString() : new Date().toISOString();
}

async function hmacB64(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const url = new URL(req.url);
  const siteKey = url.searchParams.get("k") || "";
  if (!siteKey) return json({ error: "missing k" }, 400);

  const raw = await req.text();

  const { data: tracker } = await admin
    .from("site_trackers")
    .select("id, currency, is_active, webhook_secret")
    .eq("site_key", siteKey)
    .maybeSingle();

  if (!tracker || !tracker.is_active) return json({ error: "unknown tracker" }, 404);
  if (!tracker.webhook_secret) return json({ error: "no secret set for this tracker" }, 403);

  // WooCommerce checks a new webhook before saving it, and that check is not a
  // real delivery: depending on the version it arrives as an empty body or as
  // {"webhook_id": N}, and it is never signed. Rejecting it makes the shop
  // report the webhook as broken and eventually switch it off, so it is
  // answered before the secret is checked. Nothing is written and nothing is
  // read back, so an unsigned ping learns only that the tracker exists — which
  // its own site key already tells it.
  // WooCommerce's deliver_ping() posts `webhook_id=N` form-encoded, not JSON,
  // so this has to be caught before any parsing.
  if (!raw.trim() || /^webhook_id=/.test(raw.trim())) return json({ ping: true });

  let body: unknown;
  try { body = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }

  const asPing = body as { webhook_id?: unknown; id?: unknown; total?: unknown };
  if (asPing && asPing.webhook_id != null && asPing.id == null && asPing.total == null) {
    return json({ ping: true });
  }

  // Either the shared secret outright, or WooCommerce's signature over the body.
  const given = req.headers.get("x-bluead-secret");
  const sig   = req.headers.get("x-wc-webhook-signature");
  let ok = given != null && given === tracker.webhook_secret;
  if (!ok && sig) ok = sig === await hmacB64(tracker.webhook_secret, raw);
  if (!ok) return json({ error: "bad secret" }, 401);

  const list: Record<string, unknown>[] = Array.isArray((body as { orders?: unknown }).orders)
    ? (body as { orders: Record<string, unknown>[] }).orders
    : [body as Record<string, unknown>];

  const rows: Record<string, unknown>[] = [];
  const dead: string[] = [];

  for (const o of list) {
    const id = o.id ?? o.number;
    if (id == null) continue;
    const status = String(o.status ?? "");
    if (DEAD.has(status)) { dead.push(String(id)); continue; }
    rows.push({
      tracker_id: tracker.id,
      event: "purchase",
      session_id: "woocommerce",
      path: "/checkout/order-received/",
      order_id: String(id),
      value: Number(o.total) || 0,
      currency: String(o.currency || tracker.currency || ""),
      quantity: qtyOf(o),
      created_at: whenOf(o),
      meta: { status, source: "woocommerce" },
    });
  }

  let written = 0;
  if (rows.length) {
    const { error, data } = await admin
      .from("site_events")
      .upsert(rows, { onConflict: "tracker_id,order_id", ignoreDuplicates: false })
      .select("id");
    if (error) return json({ error: error.message }, 500);
    written = data?.length ?? 0;
  }

  let removed = 0;
  if (dead.length) {
    const { data } = await admin
      .from("site_events")
      .delete()
      .eq("tracker_id", tracker.id)
      .eq("event", "purchase")
      .in("order_id", dead)
      .select("id");
    removed = data?.length ?? 0;
  }

  return json({ received: list.length, written, removed });
});
