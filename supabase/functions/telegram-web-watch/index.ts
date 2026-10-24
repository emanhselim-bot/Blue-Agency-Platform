/**
 * telegram-web-watch — Supabase Edge Function
 *
 * Twice a day, 11:00 and 22:00 Cairo: every client that sells through a
 * website, with today so far, yesterday, and the seven-day average beside
 * them, and a red mark against any figure that needs looking at.
 *
 * Why it is separate from telegram-report:
 *
 * The noon report reads the team's Notion sheet, which is filled the next
 * morning and is often a day or two behind. That is fine for a daily summary
 * and useless for a check at 11am and 10pm — the days you most want to see
 * are exactly the ones the sheet has not reached. This reads Shopify and Meta
 * directly instead, so "today" means today.
 *
 * It exists because Ibriz lost 68% of its orders over four days and nobody
 * knew until someone looked. The numbers were all there.
 *
 * ── What gets a red mark ──────────────────────────────────────────────
 *
 *   ROAS below 1.5x with real spend        — at most margins that is a loss
 *   Spend with no orders at all            — the clearest waste there is
 *   Yesterday's orders ≤ 60% of the average — a real drop, not a quiet day
 *   Today already past yesterday's spend with no orders
 *
 * A stale sheet gets a warning rather than a red mark: it is a reporting
 * problem, not a trading one, but it is why the dashboard would be showing
 * 0.00x for a client that actually sold.
 *
 * POST { cron_secret, dry_run?, force? }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ROAS_FLOOR = 1.5;        // below this, with spend, is a loss at most margins
const DROP_RATIO = 0.6;        // yesterday at or under 60% of the 7-day average
const BATCH = 6;               // Meta calls in flight at once
const LIMIT = 3500;            // Telegram refuses over 4096

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

/** Cairo's own date and hour — Egypt moves its clocks, so this is not a fixed offset. */
function cairoNow(at = new Date()) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(at).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

function shift(ymd: string, days: number) {
  const d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const int = (v: number) => Math.round(v).toLocaleString("en");
const money = (v: number, cur: string) => `${cur}${Math.round(v).toLocaleString("en")}`;
const niceDay = (ymd: string) =>
  new Date(ymd + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

type Store = {
  storeId: string;
  domain: string;
  name: string;
  currency: string;
  accountIds: string[];     // Meta ad accounts pointing at this store
  notionKeys: string[];     // notion_daily keys, for the staleness check
};

/**
 * One entry per shop, not per ad account.
 *
 * The website is the business: Ibriz runs two ad accounts and an extra
 * "Iba New" against one store, and Nuya the same. Counting per ad account
 * would report the same orders three times.
 */
async function loadStores(orgId: string): Promise<Store[]> {
  const { data: accounts } = await admin
    .from("meta_ad_accounts")
    .select("id, account_name, currency, shopify_store_id, notion_url")
    .eq("organization_id", orgId).eq("is_active", true)
    .not("shopify_store_id", "is", null);

  const { data: shops } = await admin
    .from("shopify_stores").select("id, shop_name, shop_domain")
    .eq("organization_id", orgId);
  const { data: groups } = await admin
    .from("account_groups").select("id, name, notion_url").eq("organization_id", orgId);

  type Shop  = { id: string; shop_name?: string | null; shop_domain?: string | null };
  type Group = { id: string; name?: string | null; notion_url?: string | null };
  const shopById = new Map(((shops ?? []) as Shop[]).map((s: Shop) => [String(s.id), s]));
  const groupByUrl = new Map(((groups ?? []) as Group[])
    .filter((g: Group) => g.notion_url)
    .map((g: Group) => [String(g.notion_url).trim(), g]));

  const byStore = new Map<string, Store>();
  for (const a of accounts ?? []) {
    const sid = String(a.shopify_store_id);
    const shop = shopById.get(sid);
    if (!shop) continue;
    const url = String(a.notion_url ?? "").trim();
    const group = url ? groupByUrl.get(url) : undefined;

    let s = byStore.get(sid);
    if (!s) {
      s = {
        storeId: sid,
        domain: String(shop.shop_domain ?? ""),
        // The group's name where there is one; it is the client's real name.
        name: String(group?.name ?? shop.shop_name ?? a.account_name ?? shop.shop_domain),
        currency: String(a.currency ?? "") + " ",
        accountIds: [], notionKeys: [],
      };
      byStore.set(sid, s);
    }
    // A group name beats a shop handle like "h3seh2-uf".
    if (group?.name) s.name = String(group.name);
    s.accountIds.push(String(a.id));
    s.notionKeys.push(String(a.id));
    if (group) s.notionKeys.push("__group__" + group.id);
  }
  return [...byStore.values()].sort((x, y) => x.name.localeCompare(y.name));
}

/** Shopify orders for one store, grouped by Cairo day. */
async function shopifyByDay(storeId: string, from: string, to: string) {
  const { data } = await admin
    .from("shopify_orders")
    .select("total_price, created_at_shopify, cancelled_at")
    .eq("store_id", storeId)
    .gte("created_at_shopify", from + "T00:00:00+02:00")
    .lte("created_at_shopify", to + "T23:59:59+03:00");

  const byDay = new Map<string, { orders: number; gross: number }>();
  for (const o of data ?? []) {
    // Cairo, not UTC: an order at 1am Cairo is today's, not yesterday's.
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(String(o.created_at_shopify)));
    const cur = byDay.get(day) ?? { orders: 0, gross: 0 };
    // A cancelled order is not a sale. Counting it is how a bad day looks fine.
    if (!o.cancelled_at) {
      cur.orders++;
      cur.gross += parseFloat(String(o.total_price ?? "0")) || 0;
    }
    byDay.set(day, cur);
  }
  return byDay;
}

/** Meta spend for one day across a store's ad accounts. */
async function metaSpend(accountIds: string[], day: string, secret: string) {
  let total = 0, failed = 0;
  for (let i = 0; i < accountIds.length; i += BATCH) {
    const slice = accountIds.slice(i, i + BATCH);
    const out = await Promise.all(slice.map(async id => {
      try {
        const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/meta-platform`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account_db_id: id, cron_secret: secret, since: day, until: day }),
          signal: AbortSignal.timeout(25_000),
        });
        if (!r.ok) return null;
        const j = await r.json();
        return (j.platforms ?? []).reduce(
          (s: number, p: Record<string, unknown>) => s + (parseFloat(String(p.spend ?? "0")) || 0), 0);
      } catch { return null; }
    }));
    for (const v of out) v == null ? failed++ : total += v;
  }
  // Spend that could not be read is reported as unknown rather than as zero —
  // a zero would turn a failed lookup into an infinitely good ROAS.
  return { spend: total, failed };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  let body: { cron_secret?: string; dry_run?: boolean; force?: boolean; day?: string };
  try { body = await req.json(); } catch { body = {}; }

  const { data: secretRow } = await admin
    .from("app_secrets").select("value").eq("key", "notion_cron").maybeSingle();
  const secret = String(secretRow?.value ?? "");
  if (!secret || secret !== body.cron_secret) return json({ error: "Unauthorized" }, 401);

  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if ((!token || !chatId) && !body.dry_run) {
    return json({ error: "NO_TELEGRAM_CONFIG" }, 422);
  }

  // The cron fires at both hours each slot could be in Cairo across the year;
  // this decides which one it actually is.
  const now = cairoNow();
  if (!body.force && !body.dry_run && now.hour !== 11 && now.hour !== 22) {
    return json({ ok: true, skipped: true, reason: `Cairo hour is ${now.hour}` });
  }

  const today = body.day || now.date;
  const yesterday = shift(today, -1);
  const weekStart = shift(today, -7);     // seven whole days before today

  const { data: org } = await admin.from("meta_ad_accounts")
    .select("organization_id").eq("is_active", true).limit(1).maybeSingle();
  const orgId = String(org?.organization_id ?? "");
  if (!orgId) return json({ error: "No active accounts" }, 404);

  const stores = await loadStores(orgId);

  const blocks: string[] = [
    `🌐 <b>Website accounts</b> · ${esc(niceDay(today))} · ${String(now.hour).padStart(2, "0")}:00`,
  ];
  const flagged: string[] = [];

  const noFeed: string[] = [];

  for (const store of stores) {
    // Does this store's order feed work at all?
    //
    // Only Ibriz's does. The other six are connected and linked to live ad
    // accounts, but shopify_orders has never received a single order for
    // them — no webhook subscription was ever created. Reporting them as
    // "0 orders" against real spend would fire four red marks a day, every
    // day, for six clients, and the one real alarm would be lost in it.
    const { count: everOrders } = await admin
      .from("shopify_orders").select("id", { count: "exact", head: true })
      .eq("store_id", store.storeId);
    if (!everOrders) { noFeed.push(store.name); continue; }

    const days = await shopifyByDay(store.storeId, weekStart, today);
    const t = days.get(today) ?? { orders: 0, gross: 0 };
    const y = days.get(yesterday) ?? { orders: 0, gross: 0 };

    // The seven days before yesterday, so the average is not dragged by the
    // day it is being compared against.
    let wOrders = 0, wGross = 0, wDays = 0;
    for (let i = 2; i <= 8; i++) {
      const d = shift(today, -i);
      const v = days.get(d);
      if (!v) continue;
      wOrders += v.orders; wGross += v.gross; wDays++;
    }
    const avgOrders = wDays ? wOrders / wDays : null;
    const avgGross = wDays ? wGross / wDays : null;

    const [ts, ys] = await Promise.all([
      metaSpend(store.accountIds, today, secret),
      metaSpend(store.accountIds, yesterday, secret),
    ]);
    const roas = (gross: number, spend: number) => spend > 0 ? gross / spend : null;
    const tRoas = ts.failed === store.accountIds.length ? null : roas(t.gross, ts.spend);
    const yRoas = ys.failed === store.accountIds.length ? null : roas(y.gross, ys.spend);

    const marks: string[] = [];
    if (yRoas != null && yRoas < ROAS_FLOOR && ys.spend > 0) {
      marks.push(`🔴 Yesterday's ROAS ${yRoas.toFixed(2)}x is under ${ROAS_FLOOR}x`);
    }
    if (ys.spend > 0 && y.orders === 0) marks.push(`🔴 ${money(ys.spend, store.currency)} spent yesterday, no orders`);
    if (ts.spend > 0 && t.orders === 0) marks.push(`🔴 ${money(ts.spend, store.currency)} spent today, no orders yet`);
    if (avgOrders != null && avgOrders >= 3 && y.orders <= avgOrders * DROP_RATIO) {
      marks.push(`🔴 Yesterday ${y.orders} orders against a ${avgOrders.toFixed(0)}/day average`);
    }

    // Is the team's sheet keeping up? A stale sheet is why the dashboard can
    // show 0.00x for a client that actually sold.
    // Any of the three revenue columns, not just the confirmed one. Filtering
    // on web_revenue_confirmed alone reported Ibriz's sheet as never filled:
    // it has 27 days of total_revenue and zero of web_revenue_confirmed,
    // because which column a sheet uses differs per client. This is the same
    // coalesce the cards and the daily report use.
    const { data: lastRow } = await admin.from("notion_daily")
      .select("day").in("account_key", store.notionKeys)
      .or("web_revenue_confirmed.not.is.null,total_revenue.not.is.null,web_revenue.not.is.null")
      .order("day", { ascending: false }).limit(1).maybeSingle();
    const lastFilled = lastRow?.day ? String(lastRow.day).slice(0, 10) : null;
    if (!lastFilled || lastFilled < yesterday) {
      marks.push(`⚠️ Sheet filled only to ${lastFilled ? esc(niceDay(lastFilled)) : "— never"}`);
    }

    const line = (label: string, v: { orders: number; gross: number }, s: { spend: number; failed: number }, r: number | null) =>
      `${label} ${v.orders} orders · ${money(v.gross, store.currency)}`
      + (s.failed === store.accountIds.length ? " · spend —" : ` · spend ${money(s.spend, store.currency)}`)
      + (r == null ? "" : ` · <b>${r.toFixed(2)}x</b>${r < ROAS_FLOOR && s.spend > 0 ? " 🔴" : ""}`);

    blocks.push([
      `<b>${esc(store.name)}</b>`,
      line("Today", t, ts, tRoas),
      line("Yest ", y, ys, yRoas),
      avgOrders == null ? "7-day — no history"
        : `7-day ${avgOrders.toFixed(1)} orders/day · ${money(avgGross!, store.currency)}/day`,
      ...marks,
    ].join("\n"));

    if (marks.some(m => m.startsWith("🔴"))) flagged.push(store.name);
  }

  // Connected, linked to live ad accounts, and never delivered an order to
  // us. That is a broken integration, not a quiet shop, and it is the most
  // actionable line in the message — six clients are spending with no way to
  // see what came back.
  if (noFeed.length) {
    blocks.push(`🔴 <b>Shopify connected but no orders ever received (${noFeed.length})</b>\n`
      + esc(noFeed.join(", "))
      + `\nNo webhook subscription — these cannot be checked until that is fixed.`);
  }

  // Clients that sell through a website with no Shopify connected. Listed
  // rather than omitted: silence would read as "nothing to report" when the
  // truth is "cannot be checked".
  const { data: noShop } = await admin
    .from("meta_ad_accounts").select("account_name")
    .eq("organization_id", orgId).eq("is_active", true)
    .is("shopify_store_id", null).not("notion_url", "is", null);
  const names = [...new Set(((noShop ?? []) as { account_name?: string | null }[])
    .map((a: { account_name?: string | null }) => String(a.account_name)))];
  if (names.length) {
    blocks.push(`<i>Not checked — no Shopify connected (${names.length}):</i>\n` + esc(names.join(", ")));
  }

  blocks.push(`<i>🔴 = needs a look. ROAS under ${ROAS_FLOOR}x, spend with no orders, `
            + `or orders at or under ${Math.round(DROP_RATIO * 100)}% of the 7-day average.</i>`);

  // Split between clients only: a cut inside an HTML tag makes Telegram reject
  // the whole message rather than send it in pieces.
  const chunks: string[] = [];
  let cur = "";
  for (const b of blocks) {
    const joined = cur ? cur + "\n\n" + b : b;
    if (joined.length > LIMIT && cur) { chunks.push(cur); cur = b; }
    else cur = joined;
  }
  if (cur) chunks.push(cur);

  if (body.dry_run) {
    return json({ ok: true, dry_run: true, hour: now.hour, stores: stores.length,
                  flagged, chunks: chunks.length, preview: blocks.join("\n\n") });
  }

  const sent: unknown[] = [];
  try {
    for (const [i, c] of chunks.entries()) {
      if (i > 0) await new Promise(r => setTimeout(r, 400));
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: c, parse_mode: "HTML", disable_web_page_preview: true }),
      });
      if (!res.ok) throw new Error(`Telegram ${res.status}: ${(await res.text()).slice(0, 300)}`);
      sent.push(await res.json());
    }
  } catch (e) {
    return json({ error: "TELEGRAM_SEND_FAILED", detail: (e as Error).message, sent: sent.length }, 502);
  }
  return json({ ok: true, hour: now.hour, stores: stores.length, flagged, messages: sent.length });
});
