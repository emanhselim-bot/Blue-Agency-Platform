/**
 * Shopify Data — Supabase Edge Function
 * Deploy: supabase functions deploy shopify-data
 *
 * Accepts a ShopifyQL query from the dashboard and proxies it to
 * Shopify's GraphQL Analytics API, returning rows in the format
 * the dashboard's parseShopify() helper expects:
 *   { rows: [[val1, val2, ...], ...] }
 *
 * Request body:
 *   { store_id: "<shopify_stores UUID>", query: "FROM sales SHOW orders, net_sales SINCE today UNTIL today" }
 *
 * Environment variables (set automatically by Supabase):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SHOPIFY_API_VERSION = "2024-04";

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // ── 1. Authenticate ──
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Unauthorized" }, 401);

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(
    authHeader.replace("Bearer ", "")
  );
  if (authError || !user) return jsonResponse({ error: "Unauthorized" }, 401);

  // ── 2. Parse request ──
  let body: { store_id?: string; query?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { store_id, query } = body;
  if (!store_id) return jsonResponse({ error: "store_id is required" }, 400);
  if (!query)    return jsonResponse({ error: "query is required" }, 400);

  // ── 3. Look up store + access token ──
  const { data: store, error: storeErr } = await supabaseAdmin
    .from("shopify_stores")
    .select("id, shop_domain, access_token, organization_id, is_active")
    .eq("id", store_id)
    .single();

  if (storeErr || !store) return jsonResponse({ error: "Store not found" }, 404);
  if (!store.is_active)   return jsonResponse({ error: "Store is not active" }, 403);

  // ── 4. Verify org membership ──
  const { data: member } = await supabaseAdmin
    .from("organization_members")
    .select("id")
    .eq("organization_id", store.organization_id)
    .eq("user_id", user.id)
    .not("accepted_at", "is", null)
    .single();

  if (!member) return jsonResponse({ error: "Forbidden" }, 403);

  // ── 5. Call Shopify ShopifyQL via GraphQL ──
  // Shopify's ShopifyQL API accepts the exact same query syntax the dashboard uses,
  // e.g. "FROM sales SHOW orders, net_sales SINCE today UNTIL today"
  const gqlQuery = `{
    shopifyqlQuery(query: ${JSON.stringify(query)}) {
      tableData {
        rowData
        columns {
          name
          dataType
          displayName
        }
      }
      parseErrors {
        code
        message
        range {
          start { line column }
          end   { line column }
        }
      }
    }
  }`;

  let shopifyRes: Response;
  try {
    shopifyRes = await fetch(
      `https://${store.shop_domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": store.access_token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: gqlQuery }),
      }
    );
  } catch (e) {
    console.error("Shopify API unreachable:", e);
    return jsonResponse({ error: "Shopify API unreachable" }, 502);
  }

  if (!shopifyRes.ok) {
    const text = await shopifyRes.text();
    console.error("Shopify HTTP error:", shopifyRes.status, text);
    return jsonResponse({ error: `Shopify API error: ${shopifyRes.status}` }, 502);
  }

  const shopifyBody = await shopifyRes.json();

  // Surface GraphQL errors
  if (shopifyBody.errors) {
    console.error("Shopify GraphQL errors:", shopifyBody.errors);
    return jsonResponse({ error: shopifyBody.errors[0]?.message ?? "Shopify GraphQL error" }, 422);
  }

  const shopifyql = shopifyBody.data?.shopifyqlQuery;
  if (!shopifyql) return jsonResponse({ error: "Unexpected Shopify response" }, 502);

  // Surface ShopifyQL parse errors (bad query syntax)
  if (shopifyql.parseErrors?.length) {
    const msg = shopifyql.parseErrors[0]?.message ?? "ShopifyQL parse error";
    console.error("ShopifyQL parse error:", shopifyql.parseErrors);
    return jsonResponse({ error: msg }, 422);
  }

  // ── 6. Return rows in the format parseShopify() expects ──
  // tableData.rowData is already [[val1, val2, ...], ...], matching the dashboard.
  const rows: string[][] = shopifyql.tableData?.rowData ?? [];

  return jsonResponse({ rows });
});
