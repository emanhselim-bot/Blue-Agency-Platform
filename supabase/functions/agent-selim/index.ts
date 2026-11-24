/**
 * agent-selim — Supabase Edge Function
 *
 * Selim is the performance media buyer who never goes home. Twice a day —
 * 13:00 and 23:00 Cairo — he reads what every live account has done today
 * and sets it beside what that account normally does: results, cost per
 * result, ROAS, and the month so far against the months before it.
 *
 * ── Why today, and why live ───────────────────────────────────────
 *
 * The first version compared yesterday out of the team's Notion sheet. That
 * sheet is filled a day or two behind, so "yesterday" was often three days
 * ago: by the time it complained, the money was spent. Today's figures come
 * from Meta directly — spend, results and purchase value in one call per
 * account — so a campaign that broke this morning is caught this morning.
 *
 * The baselines still come from the sheet. It is the team's own reconciled
 * history, the same figures the dashboard reports, and over three months a
 * day or two of lag makes no difference to an average.
 *
 * ── Comparing part of a day with a whole one ──────────────────────
 *
 * At 13:00 every account on earth is "down", because the day is half old.
 * So ratios — cost per result, ROAS — are compared directly, and volume is
 * compared against the share of the day that has passed. The 23:00 run is
 * the one that matters most: by then the day is 96% done and the comparison
 * is nearly exact.
 *
 * ── What counts as a result ───────────────────────────────────────
 *
 * Whatever the account is buying: purchases for a shop, leads for a lead
 * account, conversations for a client who sells in the inbox. Meta names
 * these differently per objective, so the first action type that actually
 * came back is used, and the report says which one it counted.
 *
 * ── When there is no history ──────────────────────────────────────
 *
 * An account whose sheet is thin in the last three months is not skipped:
 * the window widens to whatever weeks it does have, and the report says the
 * baseline is short. Saying "no comparison available" about an account that
 * has six good weeks behind it would be a waste of six weeks.
 *
 * POST { cron_secret } — the scheduled run, reports to Telegram.
 * POST { dry_run: true } with a signed-in user's JWT — returns what he would
 * send, writes nothing, sends nothing. That is what the dashboard calls.
 * POST { cron_secret, chat_lookup: true } — the bot's recent chats, for
 * finding the id of a new group without anybody handling the bot token.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const META_API = "https://graph.facebook.com/v21.0";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const LIMIT = 3500;            // Telegram refuses over 4096
const BATCH = 5;               // Meta calls in flight at once
const PAUSE = 200;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const num = (v: unknown) => { const n = Number(v); return isFinite(n) ? n : 0; };
const pct = (a: number, b: number) => b ? (a - b) / b * 100 : null;
const money = (v: number, cur: string) => `${cur ? cur + " " : ""}${Math.round(v).toLocaleString("en")}`;
const one = (v: number) => v.toLocaleString("en", { maximumFractionDigits: 1 });
const niceDay = (ymd: string) =>
  new Date(ymd + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
/** +41% / −52%, with the sign that makes it readable at a glance. */
const delta = (p: number) => `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(0)}%`;

function cairoNow(at = new Date()) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(at).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}
function shift(ymd: string, days: number) {
  const d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const monthOf = (ymd: string) => ymd.slice(0, 7);

type Row = Record<string, unknown>;

/* ── The sheet, for the baselines ─────────────────────────────────── */

function spendOf(r: Row) {
  const total = num(r.total_spend);
  if (total > 0) return total;
  return num(r.web_spend) + num(r.msg_spend) + num(r.branding_spend)
    + num(r.engagement_spend) + num(r.follow_spend) + num(r.profile_visit_spend)
    + num(r.courses_spend) + num(r.tahfez_spend) + num(r.tiktok_spend);
}
function revenueOf(r: Row) {
  const total = num(r.total_revenue);
  if (total > 0) return total;
  return num(r.web_revenue) + num(r.msg_revenue) + num(r.revenue_courses) + num(r.revenue_tahfez);
}
const resultsOf = (r: Row) =>
  (num(r.web_orders) + num(r.msg_orders)) || num(r.leads_total) || num(r.deals_total);

type Day = { day: string; spend: number; results: number; revenue: number };

/* ── Meta, for today ──────────────────────────────────────────────── */

const RESULT_KEYS: [string, string[]][] = [
  ["purchase", ["purchase", "offsite_conversion.fb_pixel_purchase", "omni_purchase", "onsite_web_purchase"]],
  ["lead", ["lead", "offsite_conversion.fb_pixel_lead", "onsite_conversion.lead_grouped"]],
  ["conversation", ["onsite_conversion.messaging_conversation_started_7d", "onsite_conversion.total_messaging_connection"]],
  ["add to cart", ["add_to_cart", "offsite_conversion.fb_pixel_add_to_cart"]],
];

type Today = { spend: number; results: number; revenue: number; kind: string; ok: boolean };

/**
 * Today's figures for one account, straight from Meta.
 *
 * An earlier version went through the meta-platform function. That meant a
 * nested edge-function call per account, and at this fan-out most of them
 * timed out — leaving accounts that could not be read looking exactly like
 * accounts that were behaving. This asks the Graph API directly for the
 * three fields it needs, and takes the purchase value as well, which is what
 * makes a same-day ROAS possible at all.
 */
async function metaToday(metaAccountId: string, token: string, attempt = 0): Promise<Today> {
  const params = new URLSearchParams({
    fields: "spend,actions,action_values",
    date_preset: "today",
    access_token: token,
  });
  try {
    const r = await fetch(`${META_API}/act_${metaAccountId}/insights?${params}`,
      { signal: AbortSignal.timeout(30_000) });
    const j = await r.json();
    if (j.error) {
      // A token problem will not fix itself on a retry.
      if (j.error.code === 190 || j.error.type === "OAuthException") {
        return { spend: 0, results: 0, revenue: 0, kind: "", ok: false };
      }
      throw new Error(String(j.error.message ?? "meta error"));
    }
    const rows = (j.data ?? []) as Row[];
    let spend = 0;
    const actions: Record<string, number> = {};
    const values: Record<string, number> = {};
    for (const row of rows) {
      spend += num(row.spend);
      for (const a of (row.actions ?? []) as Row[]) {
        actions[String(a.action_type)] = (actions[String(a.action_type)] ?? 0) + num(a.value);
      }
      for (const a of (row.action_values ?? []) as Row[]) {
        values[String(a.action_type)] = (values[String(a.action_type)] ?? 0) + num(a.value);
      }
    }
    let results = 0, kind = "", revenue = 0;
    for (const [label, keys] of RESULT_KEYS) {
      for (const k of keys) {
        if (actions[k] > 0) { results = actions[k]; kind = label; revenue = values[k] ?? 0; break; }
      }
      if (results) break;
    }
    if (!revenue) {
      for (const k of ["purchase", "offsite_conversion.fb_pixel_purchase", "omni_purchase"]) {
        if (values[k] > 0) { revenue = values[k]; break; }
      }
    }
    return { spend, results, revenue, kind, ok: true };
  } catch {
    if (attempt === 0) {
      await new Promise(res => setTimeout(res, 700));
      return metaToday(metaAccountId, token, 1);
    }
    return { spend: 0, results: 0, revenue: 0, kind: "", ok: false };
  }
}

type Finding = {
  account_key: string; account_name: string; day: string;
  metric: string; kind: string; severity: string;
  value: number | null; baseline: number | null; baseline_long: number | null;
  message: string;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  let body: { cron_secret?: string; dry_run?: boolean; force?: boolean; day?: string; chat_lookup?: boolean };
  try { body = await req.json(); } catch { body = {}; }

  const { data: secretRow } = await admin
    .from("app_secrets").select("value").eq("key", "notion_cron").maybeSingle();
  const secret = String(secretRow?.value ?? "");
  const byCron = Boolean(secret && secret === body.cron_secret);
  if (!byCron) {
    const jwt = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    let byUser = false;
    if (jwt) {
      const { data: auth } = await admin.auth.getUser(jwt);
      byUser = Boolean(auth?.user);
    }
    if (!byUser || !body.dry_run) return json({ error: "Unauthorized" }, 401);
  }

  // Finding the id of Selim's own chat without anybody handling the bot
  // token: create the group, add the bot, say anything in it, call this.
  if (byCron && body.chat_lookup) {
    const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
    if (!token) return json({ error: "NO_TELEGRAM_TOKEN" }, 422);
    const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=50`);
    const j = await r.json();
    const seen = new Map<string, { id: number; type: string; title: string }>();
    for (const u of (j.result ?? []) as Row[]) {
      const msg = (u.message ?? u.channel_post ?? u.my_chat_member) as Row | undefined;
      const chat = msg?.chat as Row | undefined;
      if (!chat) continue;
      seen.set(String(chat.id), {
        id: Number(chat.id), type: String(chat.type ?? ""),
        title: String(chat.title ?? chat.username ?? chat.first_name ?? ""),
      });
    }
    return json({ ok: true, chats: [...seen.values()] });
  }

  const now = cairoNow();
  const today = body.day || now.date;
  const dayShare = Math.min(1, (now.hour + now.minute / 60) / 24);
  const VOLUME_FROM = 1 / 3;

  const { data: orgRow } = await admin.from("meta_ad_accounts")
    .select("organization_id").eq("is_active", true).limit(1).maybeSingle();
  const orgId = String(orgRow?.organization_id ?? "");
  if (!orgId) return json({ error: "No active accounts" }, 404);

  const { data: agent } = await admin.from("agents")
    .select("*").eq("organization_id", orgId).eq("slug", "selim").maybeSingle();
  if (agent && agent.enabled === false) return json({ ok: true, skipped: true, reason: "Selim is switched off" });
  const settings = (agent?.settings ?? {}) as Record<string, unknown>;
  const s = settings as Record<string, number>;
  const DROP = s.drop_pct ?? 35;
  const RISE = s.cost_rise_pct ?? 35;
  const MIN_RESULTS = s.min_orders ?? 3;
  const MIN_SPEND = s.min_spend ?? 300;
  const BASE_DAYS = s.base_days ?? 90;

  // Egypt moves its clocks, so a UTC cron cannot name a Cairo hour. The job
  // fires at every UTC hour the two slots can fall on and this decides
  // whether it is really one of them.
  const hours = (Array.isArray(settings.hours) ? settings.hours : [13, 23]).map(Number);
  if (!body.dry_run && !body.force && !hours.includes(now.hour)) {
    return json({ ok: true, skipped: true, reason: `Cairo hour is ${now.hour}, not one of ${hours.join(", ")}` });
  }

  const { data: accountRows } = await admin.from("meta_ad_accounts")
    .select("id, account_name, currency, meta_account_id, meta_business_managers ( access_token )")
    .eq("organization_id", orgId).eq("is_active", true);
  const live = (accountRows ?? []) as Row[];

  // ── Who gets watched: the agency's own list of live clients ───────
  const chosen = Array.isArray(settings.watch) ? (settings.watch as unknown[]).map(String) : [];
  const watch = chosen.length ? live.filter(a => chosen.includes(String(a.id))) : live;
  const dormant = live.length - watch.length;
  const watchIds = new Set(watch.map(a => String(a.id)));

  // ── History: a year of the sheet, so the window can widen when the
  //    last three months are thin ──────────────────────────────────
  const byAccount = new Map<string, Day[]>();
  const since = shift(today, -400);
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from("notion_daily")
      .select("account_key, day, total_spend, web_spend, msg_spend, branding_spend, engagement_spend,"
        + " follow_spend, profile_visit_spend, courses_spend, tahfez_spend, tiktok_spend,"
        + " web_orders, msg_orders, leads_total, deals_total,"
        + " total_revenue, web_revenue, msg_revenue, revenue_courses, revenue_tahfez")
      .eq("organization_id", orgId)
      .gte("day", since).lt("day", today)
      .order("day", { ascending: true })
      .range(from, from + 999);
    if (error) return json({ error: error.message }, 500);
    for (const r of data ?? []) {
      const key = String(r.account_key);
      if (!watchIds.has(key)) continue;
      const d: Day = {
        day: String(r.day).slice(0, 10),
        spend: spendOf(r as Row), results: resultsOf(r as Row), revenue: revenueOf(r as Row),
      };
      if (!d.spend && !d.results && !d.revenue) continue;   // a blank row is not a quiet day
      if (!byAccount.has(key)) byAccount.set(key, []);
      byAccount.get(key)!.push(d);
    }
    if (!data || data.length < 1000) break;
    if (from > 80000) break;
  }

  // ── Today, live from Meta ─────────────────────────────────────────
  const todays = new Map<string, Today>();
  for (let i = 0; i < watch.length; i += BATCH) {
    const slice = watch.slice(i, i + BATCH);
    const out = await Promise.all(slice.map(a => {
      // deno-lint-ignore no-explicit-any
      const bm = (a as any).meta_business_managers;
      const token = bm?.access_token;
      return token
        ? metaToday(String(a.meta_account_id), String(token))
        : Promise.resolve({ spend: 0, results: 0, revenue: 0, kind: "", ok: false } as Today);
    }));
    slice.forEach((a, n) => todays.set(String(a.id), out[n]));
    if (i + BATCH < watch.length) await new Promise(r => setTimeout(r, PAUSE));
  }

  /* ── The report ───────────────────────────────────────────────────
     One block per brand, every line marked. Green is not decoration:
     a line that says "ROAS 3.1x against 2.4x 🟢" is the answer to the
     question the red lines raise, which is whether the whole book is
     sliding or one account is. */

  const findings: Finding[] = [];
  const unreadable: string[] = [];
  const blocks: string[] = [];
  let spending = 0, flagged = 0;

  type Card = { name: string; lines: string[]; bad: number; spend: number };
  const cards: Card[] = [];

  for (const a of watch) {
    const key = String(a.id);
    const name = String(a.account_name ?? key).trim();
    const cur = String(a.currency ?? "");
    const t = todays.get(key);
    if (!t) continue;
    if (!t.ok) { unreadable.push(name); continue; }
    if (t.spend <= 0) continue;              // a paused account is a decision
    spending++;

    const history = byAccount.get(key) ?? [];
    // The last three months, or — when those are thin — however many of the
    // most recent days with figures can be found, back to a year.
    let window = history.filter(d => d.day >= shift(today, -BASE_DAYS));
    let short = false;
    if (window.length < 14) {
      window = history.slice(-60);
      short = window.length > 0;
    }
    const bSpend = window.reduce((n, d) => n + d.spend, 0);
    const bResults = window.reduce((n, d) => n + d.results, 0);
    const bRevenue = window.reduce((n, d) => n + d.revenue, 0);
    const bDays = window.length;
    const avgResults = bDays ? bResults / bDays : 0;
    const baseCpr = bResults ? bSpend / bResults : 0;
    const baseRoas = bSpend ? bRevenue / bSpend : 0;

    const todayCpr = t.results ? t.spend / t.results : 0;
    const todayRoas = t.spend ? t.revenue / t.spend : 0;
    const expected = avgResults * dayShare;

    const lines: string[] = [];
    let bad = 0;
    const mark = (isBad: boolean) => { if (isBad) bad++; return isBad ? "🔴" : "🟢"; };
    const add = (f: Omit<Finding, "account_key" | "account_name" | "day">) =>
      findings.push({ account_key: key, account_name: name, day: today, ...f });

    // Results so far against what the day should have produced by now.
    if (bDays) {
      if (dayShare >= VOLUME_FROM && avgResults >= MIN_RESULTS && expected >= 1) {
        const p = pct(t.results, expected);
        const isBad = p != null && p <= -DROP;
        lines.push(`${mark(isBad)} <b>Results</b> ${t.results} vs ${one(expected)} expected `
          + `· ${one(avgResults)}/day normally${p != null ? ` (${delta(p)})` : ""}`);
        if (isBad) {
          add({ metric: "results", kind: "drop", severity: "bad",
            value: t.results, baseline: expected, baseline_long: avgResults,
            message: `${name} — ${t.results} ${t.kind || "result"}s by ${String(now.hour).padStart(2, "0")}:00, `
              + `against ${one(expected)} expected (${one(avgResults)}/day normally)` });
        }
      } else {
        lines.push(`▫️ <b>Results</b> ${t.results} so far · ${one(avgResults)}/day normally`);
      }
    } else {
      lines.push(`▫️ <b>Results</b> ${t.results} so far · no history to compare with`);
    }

    // Cost per result: the comparison that holds at any hour.
    if (baseCpr > 0 && todayCpr > 0) {
      const p = pct(todayCpr, baseCpr)!;
      const isBad = p >= RISE && t.spend >= MIN_SPEND;
      lines.push(`${mark(isBad)} <b>Cost per ${t.kind || "result"}</b> ${money(todayCpr, cur)} `
        + `vs ${money(baseCpr, cur)} (${delta(p)})`);
      if (isBad) {
        add({ metric: "cost_per_result", kind: "cost", severity: "bad",
          value: todayCpr, baseline: baseCpr, baseline_long: avgResults,
          message: `${name} — ${money(todayCpr, cur)} per ${t.kind || "result"}, ${delta(p)} on ${money(baseCpr, cur)}` });
      }
    } else if (t.results === 0 && t.spend >= MIN_SPEND) {
      lines.push(`🔴 <b>Cost per result</b> — ${money(t.spend, cur)} spent, nothing back yet`);
      bad++;
      add({ metric: "results", kind: "waste", severity: "bad",
        value: 0, baseline: avgResults || null, baseline_long: baseCpr || null,
        message: `${name} — ${money(t.spend, cur)} spent, no results yet` });
    }

    // ROAS, for the accounts Meta reports a purchase value for. A lead
    // account has no purchase value and never will, so an unknown ROAS is
    // left grey: a green tick against a figure nobody has would be a lie in
    // the most reassuring direction.
    if (todayRoas > 0) {
      const p = baseRoas > 0 ? pct(todayRoas, baseRoas) : null;
      const isBad = (baseRoas > 0 && p != null && p <= -25) || todayRoas < 1;
      lines.push(`${mark(isBad)} <b>ROAS</b> ${todayRoas.toFixed(2)}x `
        + `vs ${baseRoas ? baseRoas.toFixed(2) + "x" : "—"}${p != null ? ` (${delta(p)})` : ""}`);
      if (isBad) {
        add({ metric: "roas", kind: "roas", severity: "bad",
          value: todayRoas, baseline: baseRoas || null, baseline_long: null,
          message: `${name} — ROAS ${todayRoas.toFixed(2)}x against ${baseRoas ? baseRoas.toFixed(2) + "x" : "its usual"}` });
      }
    } else if (baseRoas > 0) {
      lines.push(`▫️ <b>ROAS</b> not reported today · ${baseRoas.toFixed(2)}x normally`);
    }

    // This month against the months before it, in results per day — a
    // partial month and a whole one cannot be compared any other way.
    const thisMonth = history.filter(d => monthOf(d.day) === monthOf(today));
    const before = history.filter(d => monthOf(d.day) < monthOf(today) && d.day >= shift(today, -BASE_DAYS - 30));
    // The month comes out of the sheet, so a sheet that stopped a week ago
    // reports the month as empty. That is a filing problem, not a collapse,
    // and marking it red would bury the accounts that really are down.
    const sheetTo = thisMonth.length ? thisMonth[thisMonth.length - 1].day : "";
    const sheetStale = !sheetTo || sheetTo < shift(today, -3);
    if (thisMonth.length >= 5 && before.length >= 20) {
      const mNow = thisMonth.reduce((n, d) => n + d.results, 0) / thisMonth.length;
      const mBefore = before.reduce((n, d) => n + d.results, 0) / before.length;
      const p = pct(mNow, mBefore);
      // A month is a long time to be 20% down; it does not need the daily
      // threshold, which is set high to survive one odd Tuesday.
      const isBad = !sheetStale && p != null && p <= -20;
      lines.push(`${sheetStale ? "▫️" : mark(isBad)} <b>This month</b> ${one(mNow)}/day vs ${one(mBefore)}/day `
        + `in the months before${p != null ? ` (${delta(p)})` : ""}`
        + (sheetStale ? ` · sheet only filled to ${esc(niceDay(sheetTo))}` : ""));
      if (isBad) {
        add({ metric: "month", kind: "trend", severity: "warn",
          value: mNow, baseline: mBefore, baseline_long: null,
          message: `${name} — ${one(mNow)} results/day this month against ${one(mBefore)} before` });
      }
    }

    if (short) lines.push(`<i>baseline is only ${bDays} days — the sheet is thin for this account</i>`);
    if (bad) flagged++;
    cards.push({ name, lines, bad, spend: t.spend });
  }

  // Worst first, then by what they are spending: the account burning the
  // most money while off trend is the one to open.
  cards.sort((x, y) => (y.bad - x.bad) || (y.spend - x.spend));
  for (const c of cards) {
    blocks.push(`${c.bad ? "🔴" : "🟢"} <b>${esc(c.name)}</b>\n` + c.lines.join("\n"));
  }

  const head = `🧭 <b>SELIM</b> · ${esc(niceDay(today))} at ${String(now.hour).padStart(2, "0")}:00\n`
    + `<b>${spending}</b> accounts spending · <b>${flagged}</b> off their normal`;
  const tail: string[] = [];
  if (unreadable.length) tail.push(`<i>Meta would not answer for:</i> ${esc(unreadable.join(", "))}`);
  if (dormant) tail.push(`<i>${dormant} other active ad accounts are not on the watch list.</i>`);

  const all = [head, ...blocks, ...tail];
  if (body.dry_run) {
    return json({ ok: true, dry_run: true, spending, flagged, dormant,
      day_share: Number(dayShare.toFixed(2)), unreadable: unreadable.length,
      findings, preview: all.join("\n\n") });
  }

  // Findings are recorded for the dashboard and deduped per account, day,
  // metric and kind. The report itself is sent every scheduled run — it is
  // twice a day by design, and a report that only appears when something is
  // wrong is one nobody learns to read.
  if (findings.length) {
    await admin.from("agent_alerts").upsert(
      findings.map(f => ({ organization_id: orgId, agent_slug: "selim", ...f, sent_at: new Date().toISOString() })),
      { onConflict: "organization_id,agent_slug,account_key,day,metric,kind" },
    );
  }

  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = String(settings.telegram_chat_id ?? "") || Deno.env.get("TELEGRAM_CHAT_ID");
  let sent = 0;
  if (token && chatId && cards.length) {
    // Split between brands only: a cut inside an HTML tag makes Telegram
    // reject the whole message instead of sending it in pieces.
    const chunks: string[] = [];
    let cur = "";
    for (const b of all) {
      const joined = cur ? cur + "\n\n" + b : b;
      if (joined.length > LIMIT && cur) { chunks.push(cur); cur = b; } else cur = joined;
    }
    if (cur) chunks.push(cur);

    for (const [i, c] of chunks.entries()) {
      if (i > 0) await new Promise(r => setTimeout(r, 400));
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: c, parse_mode: "HTML", disable_web_page_preview: true }),
      });
      if (!res.ok) {
        return json({ error: "TELEGRAM_SEND_FAILED", detail: (await res.text()).slice(0, 300), sent }, 502);
      }
      sent++;
    }
  }

  await admin.from("agents").update({
    last_run_at: new Date().toISOString(),
    last_run_note: `${spending} spending · ${flagged} off trend · ${sent} message${sent === 1 ? "" : "s"}`
      + (token && chatId ? "" : " · Telegram not configured"),
  }).eq("organization_id", orgId).eq("slug", "selim");

  return json({ ok: true, spending, flagged, findings: findings.length,
    unreadable: unreadable.length, messages: sent,
    chat: settings.telegram_chat_id ? "own" : "shared",
    telegram: token && chatId ? "configured" : "missing" });
});
