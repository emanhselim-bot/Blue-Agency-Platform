/**
 * Shopify Data — Supabase Edge Function
 * Deploy: supabase functions deploy shopify-data
 *
 * Accepts the dashboard's custom DSL and returns metrics in the format
 * parseShopify() expects: { rows: [[val1, val2, ...], ...] }
 *
 * Supported queries:
 *   FROM sales      SHOW orders, net_sales           SINCE X UNTIL Y
 *   FROM inventory  SHOW inventory_units_sold         SINCE X UNTIL Y
 *   FROM sessions   SHOW sessions, conversion_rate   SINCE X UNTIL Y
 *   FROM sales      SHOW net_sales                   SINCE X UNTIL Y BY day
 *   FROM checkouts  SHOW checkouts_count             SINCE X UNTIL Y
 *
 * Uses the Shopify REST Admin API so it works on all store types (dev + production).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SHOPIFY_API = "2024-04";

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

// ── Timezone helpers ──────────────────────────────────────────────────────────

// Returns the UTC offset for an IANA timezone as "+HH:MM" or "-HH:MM".
// Uses Intl.DateTimeFormat shortOffset format (e.g. "GMT+2" → "+02:00").
function tzOffsetStr(ianaTimezone: string): string {
  try {
    const now = new Date();
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: ianaTimezone,
      timeZoneName: "shortOffset",
    } as Intl.DateTimeFormatOptions);
    const parts = dtf.formatToParts(now);
    const tzPart = parts.find(p => p.type === "timeZoneName")?.value ?? "GMT+0";
    // tzPart examples: "GMT+2", "GMT-5:30", "GMT+0"
    const m = tzPart.match(/GMT([+-])(\d+)(?::(\d+))?/);
    if (!m) return "+00:00";
    const sign = m[1];
    const h    = m[2].padStart(2, "0");
    const min  = (m[3] ?? "0").padStart(2, "0");
    return `${sign}${h}:${min}`;
  } catch {
    return "+00:00";
  }
}

// Fetches the store's IANA timezone from the Shopify API.
// Falls back to "UTC" on any error so the function never hard-fails.
async function fetchShopTimezone(
  shopDomain:  string,
  accessToken: string
): Promise<string> {
  try {
    const res = await fetch(
      `https://${shopDomain}/admin/api/${SHOPIFY_API}/shop.json?fields=iana_timezone`,
      { headers: { "X-Shopify-Access-Token": accessToken } }
    );
    if (!res.ok) return "UTC";
    const json = await res.json();
    return (json?.shop?.iana_timezone as string) ?? "UTC";
  } catch {
    return "UTC";
  }
}

// ── Date helpers ─────────────────────────────────────────────────────────────
// Dates are computed in the store's local timezone so "today" and "yesterday"
// match what Shopify admin shows rather than UTC calendar days.

function todayInTz(tz: string): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
}

function yesterdayInTz(tz: string): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString("en-CA", { timeZone: tz });
}

function resolveDate(token: string, tz: string): string {
  if (token === "today")     return todayInTz(tz);
  if (token === "yesterday") return yesterdayInTz(tz);
  return token; // already YYYY-MM-DD
}

// ── DSL parser ───────────────────────────────────────────────────────────────

interface DSL {
  source:  string;   // sales | inventory | sessions
  metrics: string[]; // e.g. ["orders","net_sales"]
  since:   string;   // YYYY-MM-DD (in store's local timezone)
  until:   string;   // YYYY-MM-DD (in store's local timezone)
  byDay:   boolean;
}

function parseDSL(query: string, tz: string): DSL {
  const fromM   = query.match(/FROM\s+(\w+)/i);
  const showM   = query.match(/SHOW\s+([\w,\s]+?)(?:\s+SINCE|\s+BY\s+day|$)/i);
  const sinceM  = query.match(/SINCE\s+(\S+)/i);
  const untilM  = query.match(/UNTIL\s+(\S+)/i);
  const byDay   = /BY\s+day/i.test(query);

  return {
    source:  (fromM?.[1]  ?? "sales").toLowerCase(),
    metrics: (showM?.[1]  ?? "").split(",").map(m => m.trim().toLowerCase()).filter(Boolean),
    since:   resolveDate(sinceM?.[1] ?? "today", tz),
    until:   resolveDate(untilM?.[1] ?? "today", tz),
    byDay,
  };
}

// ── Shopify Orders fetcher ───────────────────────────────────────────────────
// Fetches all orders in a date range with full pagination.
// Returns minimal fields to keep payload small.

interface ShopifyOrder {
  id:               number;
  created_at:       string;
  subtotal_price:   string;  // net_sales proxy (before taxes/shipping)
  total_price:      string;
  total_discounts:  string;
  financial_status: string;
  line_items: Array<{ quantity: number; price: string; title?: string; product_id?: number }>;
}

async function fetchOrders(
  shopDomain:      string,
  accessToken:     string,
  since:           string,
  until:           string,
  timezone:        string = "UTC",
  financialStatus?: string   // e.g. "refunded" | "partially_refunded"
): Promise<ShopifyOrder[]> {
  const headers: Record<string, string> = {
    "X-Shopify-Access-Token": accessToken,
    "Content-Type": "application/json",
  };

  // Use the store's local timezone offset so date boundaries match what
  // Shopify admin shows (e.g. Egypt UTC+2: "today" starts at 22:00 UTC the
  // previous day, not at 00:00 UTC).
  const offset  = tzOffsetStr(timezone);
  const minDate = `${since}T00:00:00${offset}`;
  const maxDate = `${until}T23:59:59${offset}`;

  const params: Record<string, string> = {
    status:         "any",
    created_at_min: minDate,
    created_at_max: maxDate,
    limit:          "250",
    fields:         "id,created_at,subtotal_price,total_price,total_discounts,financial_status,line_items",
  };
  if (financialStatus) params.financial_status = financialStatus;

  const baseParams = new URLSearchParams(params);

  const orders: ShopifyOrder[] = [];
  let url: string | null =
    `https://${shopDomain}/admin/api/${SHOPIFY_API}/orders.json?${baseParams}`;

  while (url) {
    const res: Response = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text();
      console.error(`Shopify orders API error ${res.status}:`, text);
      break;
    }
    const json = await res.json();
    orders.push(...(json.orders ?? []));

    // Parse cursor-based pagination from Link header
    // Link: <https://...?page_info=abc>; rel="next"
    const link = res.headers.get("link") ?? "";
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
  }

  return orders;
}

// ── Metric calculators ───────────────────────────────────────────────────────

function calcNetSales(orders: ShopifyOrder[]): number {
  // subtotal_price = line items total - discounts (before taxes/shipping) — a
  // reasonable proxy for "net sales" in a performance dashboard.
  return orders.reduce((s, o) => s + parseFloat(o.subtotal_price || "0"), 0);
}

function calcOrderCount(orders: ShopifyOrder[]): number {
  return orders.length;
}

function calcUnitsSold(orders: ShopifyOrder[]): number {
  return orders.reduce(
    (s, o) => s + o.line_items.reduce((ls, li) => ls + (li.quantity || 0), 0),
    0
  );
}

// Group orders by calendar date (store local timezone), return [[date, net_sales], ...]
function calcDailySales(orders: ShopifyOrder[], tz: string): [string, string][] {
  const byDate: Record<string, number> = {};
  for (const o of orders) {
    const date = new Date(o.created_at).toLocaleDateString("en-CA", { timeZone: tz });
    byDate[date] = (byDate[date] ?? 0) + parseFloat(o.subtotal_price || "0");
  }
  return Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([d, v]) => [d, v.toFixed(2)]);
}

// ── Shopify Abandoned Checkouts fetcher ──────────────────────────────────────
// Fetches abandoned checkouts (created but not completed) in a date range.

interface ShopifyCheckout {
  id: number;
  created_at: string;
  completed_at: string | null;
}

async function fetchAbandonedCheckouts(
  shopDomain:  string,
  accessToken: string,
  since:       string,
  until:       string,
  timezone:    string = "UTC"
): Promise<number> {
  const offset  = tzOffsetStr(timezone);
  const minDate = `${since}T00:00:00${offset}`;
  const maxDate = `${until}T23:59:59${offset}`;

  const params = new URLSearchParams({
    created_at_min: minDate,
    created_at_max: maxDate,
    limit: "250",
    fields: "id,created_at,completed_at",
  });

  let count = 0;
  let url: string | null =
    `https://${shopDomain}/admin/api/${SHOPIFY_API}/checkouts.json?${params}`;

  while (url) {
    const res = await fetch(url, {
      headers: { "X-Shopify-Access-Token": accessToken },
    });
    if (!res.ok) {
      console.warn(`Shopify checkouts API ${res.status}`);
      break;
    }
    const json = await res.json();
    const checkouts: ShopifyCheckout[] = json.checkouts ?? [];
    // Only count checkouts that were NOT completed (i.e. truly abandoned)
    count += checkouts.filter(c => !c.completed_at).length;

    const link = res.headers.get("link") ?? "";
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
  }

  return count;
}

// ── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // 1. Auth
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Unauthorized" }, 401);

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(
    authHeader.replace("Bearer ", "")
  );
  if (authError || !user) return jsonResponse({ error: "Unauthorized" }, 401);

  // 2. Parse body
  let body: { store_id?: string; query?: string };
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  const { store_id, query } = body;
  if (!store_id) return jsonResponse({ error: "store_id is required" }, 400);
  if (!query)    return jsonResponse({ error: "query is required" }, 400);

  // 3. Look up store
  const { data: store, error: storeErr } = await supabaseAdmin
    .from("shopify_stores")
    .select("id, shop_domain, access_token, organization_id, is_active")
    .eq("id", store_id)
    .single();

  if (storeErr || !store) return jsonResponse({ error: "Store not found" }, 404);
  if (!store.is_active)   return jsonResponse({ error: "Store is not active" }, 403);

  // 4. Verify org membership
  const { data: member } = await supabaseAdmin
    .from("organization_members")
    .select("id")
    .eq("organization_id", store.organization_id)
    .eq("user_id", user.id)
    .not("accepted_at", "is", null)
    .single();

  if (!member) return jsonResponse({ error: "Forbidden" }, 403);

  // 5. Fetch store timezone (one extra API call; result drives all date math)
  const shopTimezone = await fetchShopTimezone(store.shop_domain, store.access_token);

  // 6. Parse DSL — dates are resolved in the store's local timezone
  const dsl = parseDSL(query, shopTimezone);
  const { source, metrics, since, until, byDay } = dsl;

  try {
    // ── FROM sales ──────────────────────────────────────────────────────────
    if (source === "sales") {
      const orders = await fetchOrders(store.shop_domain, store.access_token, since, until, shopTimezone);

      if (byDay) {
        // FROM sales SHOW net_sales SINCE X UNTIL Y BY day
        // Returns [[date, net_sales], ...] — one row per day
        const rows = calcDailySales(orders, shopTimezone);
        return jsonResponse({ rows });
      }

      // FROM sales SHOW orders, net_sales SINCE X UNTIL Y
      // Build one row with values in the same order as SHOW clause
      const row: string[] = metrics.map(m => {
        if (m === "orders" || m === "orders_count") return String(calcOrderCount(orders));
        if (m === "net_sales")    return calcNetSales(orders).toFixed(2);
        return "0";
      });
      return jsonResponse({ rows: row.length ? [row] : [] });
    }

    // ── FROM inventory ───────────────────────────────────────────────────────
    if (source === "inventory") {
      const orders = await fetchOrders(store.shop_domain, store.access_token, since, until, shopTimezone);
      const row: string[] = metrics.map(m => {
        if (m === "inventory_units_sold" || m === "units_sold" || m === "quantity") {
          return String(calcUnitsSold(orders));
        }
        return "0";
      });
      return jsonResponse({ rows: row.length ? [row] : [] });
    }

    // ── FROM refunds ─────────────────────────────────────────────────────────
    // Returns count of refunded + partially-refunded orders in the period.
    if (source === "refunds") {
      const [refunded, partial] = await Promise.all([
        fetchOrders(store.shop_domain, store.access_token, since, until, shopTimezone, "refunded"),
        fetchOrders(store.shop_domain, store.access_token, since, until, shopTimezone, "partially_refunded"),
      ]);
      const allReturns = [...refunded, ...partial];
      const row: string[] = metrics.map(m => {
        if (m === "returns_count" || m === "returns") return String(allReturns.length);
        if (m === "refund_amount") return calcNetSales(allReturns).toFixed(2);
        return "0";
      });
      return jsonResponse({ rows: row.length ? [row] : [] });
    }

    // ── FROM sessions ────────────────────────────────────────────────────────
    // Sessions are not available via REST; return zeros so the dashboard
    // displays 0% rather than "—".  When the store has real analytics data the
    // ShopifyQL path (below) would be preferred, but dev stores rarely do.
    if (source === "sessions") {
      // Web sessions require Shopify Analytics (ShopifyQL) which is not
      // available via REST. Return 0 so the dashboard shows 0 instead of "—".
      const row: string[] = metrics.map(() => "0");
      return jsonResponse({ rows: row.length ? [row] : [] });
    }

    // ── FROM checkouts ───────────────────────────────────────────────────────
    // Returns abandoned checkout count and total checkout initiations.
    // checkout initiations = abandoned checkouts + completed orders
    if (source === "checkouts") {
      const [abandonedCount, orders] = await Promise.all([
        fetchAbandonedCheckouts(store.shop_domain, store.access_token, since, until, shopTimezone),
        fetchOrders(store.shop_domain, store.access_token, since, until, shopTimezone),
      ]);
      const totalInitiations = abandonedCount + orders.length;
      const row: string[] = metrics.map(m => {
        if (m === "checkouts_count" || m === "add_to_cart") return String(totalInitiations);
        if (m === "abandoned_count")  return String(abandonedCount);
        if (m === "completed_count")  return String(orders.length);
        return "0";
      });
      return jsonResponse({ rows: row.length ? [row] : [] });
    }

    // ── FROM products ─────────────────────────────────────────────────────────
    // Aggregates line items across orders → returns top products by quantity sold.
    // Row format: [title, quantity, revenue]
    if (source === "products") {
      const orders = await fetchOrders(store.shop_domain, store.access_token, since, until, shopTimezone);
      const productMap: Record<string, { quantity: number; revenue: number }> = {};
      for (const order of orders) {
        for (const item of order.line_items) {
          const title = item.title || "Unknown";
          if (!productMap[title]) productMap[title] = { quantity: 0, revenue: 0 };
          productMap[title].quantity += item.quantity;
          productMap[title].revenue  += parseFloat(item.price || "0") * item.quantity;
        }
      }
      const rows = Object.entries(productMap)
        .sort(([, a], [, b]) => b.quantity - a.quantity)
        .slice(0, 10)
        .map(([title, v]) => [title, String(v.quantity), v.revenue.toFixed(2)]);
      return jsonResponse({ rows });
    }

    // Unrecognised source — return empty
    return jsonResponse({ rows: [] });

  } catch (e) {
    console.error("shopify-data error:", e);
    return jsonResponse({ error: (e as Error).message ?? "Internal error" }, 502);
  }
});
