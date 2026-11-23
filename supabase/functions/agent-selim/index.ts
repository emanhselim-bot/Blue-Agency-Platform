/**
 * agent-selim — Supabase Edge Function
 *
 * Selim is the performance media buyer who never goes home. Three times a day
 * he reads every active account's daily figures and says, in Telegram, which
 * ones have gone off — fewer results, dearer results, or a ROAS that no
 * longer pays.
 *
 * ── How he decides something is wrong ─────────────────────────────
 *
 * Two comparisons, because they answer different questions:
 *
 *   Yesterday against the last 14 days   — did something break just now?
 *   The last 14 days against 6 months    — has this been sliding for weeks?
 *
 * The first catches a campaign that died overnight. The second catches the
 * account that has quietly cost twice as much per order since September,
 * which no daily comparison will ever show, because each day looks like the
 * one before it.
 *
 * Volume floors matter more than the thresholds do. An account averaging one
 * order a day will "drop 100%" twice a week and teach everyone to ignore the
 * alarms, so a drop is only reported where the baseline has enough in it to
 * mean something.
 *
 * ── What he reads ─────────────────────────────────────────────────
 *
 * notion_daily, the team's own sheet: it is the only per-account daily record
 * that covers lead clients as well as shops, and it carries the figures the
 * dashboard itself reports, so an alarm always matches what you see when you
 * open the account. The sheet is filled a day or two behind, so Selim works
 * from the newest day each account actually has rather than from the
 * calendar, and says so when a sheet has stopped.
 *
 * POST { cron_secret } — the scheduled run, sends to Telegram.
 * POST { dry_run: true } with a signed-in user's JWT — returns what he would
 * say, writes nothing, sends nothing. That is what the dashboard calls.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

const LIMIT = 3500;            // Telegram refuses over 4096
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const num = (v: unknown) => { const n = Number(v); return isFinite(n) ? n : 0; };
const pct = (a: number, b: number) => b ? (a - b) / b * 100 : null;
const money = (v: number, cur: string) => `${cur ? cur + " " : ""}${Math.round(v).toLocaleString("en")}`;
const niceDay = (ymd: string) =>
  new Date(ymd + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

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

type Row = Record<string, unknown>;

/**
 * Spend for a day.
 *
 * total_spend is the sheet's own total where the team fills it; where they
 * fill the per-objective columns instead it stays empty, and adding both
 * would double the account's spend. Same rule the dashboard uses.
 */
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
const ordersOf = (r: Row) => num(r.web_orders) + num(r.msg_orders);
const leadsOf  = (r: Row) => num(r.leads_total) || num(r.deals_total);

type Daily = { day: string; spend: number; revenue: number; orders: number; leads: number };
const toDaily = (r: Row): Daily => ({
  day: String(r.day).slice(0, 10),
  spend: spendOf(r), revenue: revenueOf(r), orders: ordersOf(r), leads: leadsOf(r),
});

/** Mean over the days that exist. An account that pauses for a week should
 *  not have its average halved by the days nobody spent anything. */
function mean(rows: Daily[], pick: (d: Daily) => number) {
  const vals = rows.map(pick).filter(v => v > 0);
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
const sum = (rows: Daily[], pick: (d: Daily) => number) => rows.reduce((a, d) => a + pick(d), 0);

type Finding = {
  account_key: string; account_name: string; day: string;
  metric: string; kind: string; severity: string;
  value: number | null; baseline: number | null; baseline_long: number | null;
  message: string;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  let body: { cron_secret?: string; dry_run?: boolean; force?: boolean; day?: string };
  try { body = await req.json(); } catch { body = {}; }

  // Two ways in: the cron secret for the scheduled run, or a signed-in member
  // of the organisation asking for a preview. A preview never sends and never
  // writes, so it cannot be used to spam the channel.
  const { data: secretRow } = await admin
    .from("app_secrets").select("value").eq("key", "notion_cron").maybeSingle();
  const secret = String(secretRow?.value ?? "");
  const byCron = Boolean(secret && secret === body.cron_secret);
  let byUser = false;
  if (!byCron) {
    const jwt = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    if (jwt) {
      const { data: auth } = await admin.auth.getUser(jwt);
      byUser = Boolean(auth?.user);
    }
    if (!byUser || !body.dry_run) return json({ error: "Unauthorized" }, 401);
  }

  const now = cairoNow();
  const { data: orgRow } = await admin.from("meta_ad_accounts")
    .select("organization_id").eq("is_active", true).limit(1).maybeSingle();
  const orgId = String(orgRow?.organization_id ?? "");
  if (!orgId) return json({ error: "No active accounts" }, 404);

  const { data: agent } = await admin.from("agents")
    .select("*").eq("organization_id", orgId).eq("slug", "selim").maybeSingle();
  if (agent && agent.enabled === false) return json({ ok: true, skipped: true, reason: "Selim is switched off" });
  const s = (agent?.settings ?? {}) as Record<string, number>;
  const DROP = s.drop_pct ?? 35, RISE = s.cost_rise_pct ?? 35, TREND = s.trend_pct ?? 25;
  const ROAS_FLOOR = s.roas_floor ?? 1.0, MIN_ORDERS = s.min_orders ?? 3;
  const MIN_SPEND = s.min_spend ?? 300, SHORT = s.short_days ?? 14, LONG = s.long_days ?? 180;

  // Names, so an alarm says "Ibriz" rather than a uuid.
  const { data: accounts } = await admin.from("meta_ad_accounts")
    .select("id, account_name, currency").eq("organization_id", orgId).eq("is_active", true);
  const nameOf = new Map<string, { name: string; currency: string }>(
    (accounts ?? []).map((a: Row) => [String(a.id), {
      name: String(a.account_name ?? a.id), currency: String(a.currency ?? ""),
    }]));

  const today = body.day || now.date;
  const since = shift(today, -(LONG + 2));

  // Everything in one pass, paged: PostgREST stops at 1000 rows and says
  // nothing, and six months across twenty-five accounts is far past that.
  const rowsByKey = new Map<string, Daily[]>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from("notion_daily").select("*")
      .eq("organization_id", orgId)
      .gte("day", since).lte("day", today)
      .order("day", { ascending: true })
      .range(from, from + 999);
    if (error) return json({ error: error.message }, 500);
    for (const r of data ?? []) {
      const key = String(r.account_key);
      if (!rowsByKey.has(key)) rowsByKey.set(key, []);
      rowsByKey.get(key)!.push(toDaily(r as Row));
    }
    if (!data || data.length < 1000) break;
    if (from > 40000) break;
  }

  const findings: Finding[] = [];
  const stale: string[] = [];
  let checked = 0;

  for (const [key, all] of rowsByKey) {
    const info = nameOf.get(key);
    // Group keys and accounts that have been switched off still have history;
    // only live ad accounts are worth an alarm.
    if (!info) continue;
    const name = info.name.trim(), cur = info.currency;

    const withAnything = all.filter(d => d.spend > 0 || d.orders > 0 || d.leads > 0 || d.revenue > 0);
    if (!withAnything.length) continue;
    const last = withAnything[withAnything.length - 1];

    // The sheet is filled behind, so "yesterday" means the newest day it has.
    // More than three days behind is a reporting problem, not a trading one:
    // it is reported once, quietly, and the account is skipped rather than
    // judged on figures nobody has entered.
    if (last.day < shift(today, -3)) { stale.push(`${name} (${niceDay(last.day)})`); continue; }
    checked++;

    const before = withAnything.filter(d => d.day < last.day);
    const short = before.slice(-SHORT);
    const long = before;

    const results = (d: Daily) => d.orders || d.leads;
    const unit = last.orders || mean(short, d => d.orders) ? "order" : "lead";

    const sResults = mean(short, results), lResults = mean(long, results);
    const sSpend = mean(short, d => d.spend);
    const sCost = sum(short, d => d.spend) && sum(short, results)
      ? sum(short, d => d.spend) / sum(short, results) : 0;
    const lCost = sum(long, d => d.spend) && sum(long, results)
      ? sum(long, d => d.spend) / sum(long, results) : 0;
    const sRoas = sum(short, d => d.spend) ? sum(short, d => d.revenue) / sum(short, d => d.spend) : 0;

    const dayResults = results(last);
    const dayCost = dayResults ? last.spend / dayResults : 0;
    const dayRoas = last.spend ? last.revenue / last.spend : 0;
    const add = (f: Omit<Finding, "account_key" | "account_name" | "day">) =>
      findings.push({ account_key: key, account_name: name, day: last.day, ...f });

    // 1. Spend with nothing to show for it. The clearest waste there is — but
    //    the team enters spend in the morning and the results later, so on
    //    the newest row a zero may simply be a half-typed day. Where a newer
    //    row exists the day is closed and the zero is real; where it does
    //    not, it is flagged as something to confirm rather than as a loss.
    const dayClosed = all.some(d => d.day > last.day);
    if (last.spend >= MIN_SPEND && dayResults === 0) {
      add({ metric: "results", kind: "waste", severity: dayClosed ? "bad" : "warn",
        value: 0, baseline: sResults || null, baseline_long: lResults || null,
        message: `${esc(name)} — ${money(last.spend, cur)} spent on ${niceDay(last.day)}, no ${unit}s recorded`
          + (sResults ? ` (usually ${sResults.toFixed(1)}/day)` : "")
          + (dayClosed ? "" : " — check the sheet is filled for that day") });
    }

    // 2. Results down against the account's own fortnight.
    const dropPct = pct(dayResults, sResults);
    if (sResults >= MIN_ORDERS && dropPct != null && dropPct <= -DROP && dayResults > 0) {
      add({ metric: unit === "lead" ? "leads" : "orders", kind: "drop", severity: "bad",
        value: dayResults, baseline: sResults, baseline_long: lResults || null,
        message: `${esc(name)} — ${dayResults} ${unit}s on ${niceDay(last.day)}, `
          + `${Math.abs(dropPct).toFixed(0)}% under the ${SHORT}-day average of ${sResults.toFixed(1)}`
          + (lResults ? ` · 6-month average ${lResults.toFixed(1)}` : "") });
    }

    // 3. Each result costing materially more than it has been.
    const risePct = pct(dayCost, sCost);
    if (sCost > 0 && dayResults > 0 && risePct != null && risePct >= RISE && last.spend >= MIN_SPEND) {
      add({ metric: unit === "lead" ? "cost_per_lead" : "cost_per_order", kind: "cost", severity: "bad",
        value: dayCost, baseline: sCost, baseline_long: lCost || null,
        message: `${esc(name)} — ${money(dayCost, cur)} per ${unit} on ${niceDay(last.day)}, `
          + `up ${risePct.toFixed(0)}% on the ${SHORT}-day ${money(sCost, cur)}`
          + (lCost ? ` · 6-month ${money(lCost, cur)}` : "") });
    }

    // 4. ROAS that no longer pays, for the shops that report revenue.
    if (sum(short, d => d.revenue) > 0 && last.spend >= MIN_SPEND && dayRoas > 0 && dayRoas < ROAS_FLOOR) {
      add({ metric: "roas", kind: "roas", severity: "bad",
        value: dayRoas, baseline: sRoas || null, baseline_long: null,
        message: `${esc(name)} — ROAS ${dayRoas.toFixed(2)}x on ${niceDay(last.day)}, under ${ROAS_FLOOR}x`
          + (sRoas ? ` · ${SHORT}-day ${sRoas.toFixed(2)}x` : "") });
    }

    // 5. The slow slide: the fortnight itself adrift of the half-year. Not a
    //    bad day — a worse month than the account used to have, which is the
    //    thing no daily comparison can see.
    const trendResults = pct(sResults, lResults);
    if (long.length >= 60 && lResults >= MIN_ORDERS && trendResults != null && trendResults <= -TREND) {
      add({ metric: unit === "lead" ? "leads" : "orders", kind: "trend", severity: "warn",
        value: sResults, baseline: lResults, baseline_long: lResults,
        message: `${esc(name)} — last ${SHORT} days averaging ${sResults.toFixed(1)} ${unit}s/day `
          + `against ${lResults.toFixed(1)} over 6 months (${Math.abs(trendResults).toFixed(0)}% down)` });
    }
    const trendCost = pct(sCost, lCost);
    if (long.length >= 60 && lCost > 0 && trendCost != null && trendCost >= TREND && sSpend >= MIN_SPEND) {
      add({ metric: unit === "lead" ? "cost_per_lead" : "cost_per_order", kind: "trend", severity: "warn",
        value: sCost, baseline: lCost, baseline_long: lCost,
        message: `${esc(name)} — ${money(sCost, cur)} per ${unit} over the last ${SHORT} days `
          + `against ${money(lCost, cur)} over 6 months (up ${trendCost.toFixed(0)}%)` });
    }
  }

  const bad = findings.filter(f => f.severity === "bad");
  const warn = findings.filter(f => f.severity === "warn");

  const blocks: string[] = [
    `🧭 <b>Selim</b> · performance watch · ${esc(niceDay(today))} ${String(now.hour).padStart(2, "0")}:00`,
  ];
  if (bad.length) blocks.push(`🔴 <b>Needs a look today (${bad.length})</b>\n` + bad.map(f => "• " + f.message).join("\n"));
  if (warn.length) blocks.push(`🟠 <b>Worth a check (${warn.length})</b>\n` + warn.map(f => "• " + f.message).join("\n"));
  if (!findings.length) blocks.push(`✅ ${checked} accounts checked, nothing off trend.`);
  if (stale.length) {
    blocks.push(`<i>Not checked — sheet more than 3 days behind (${stale.length}):</i>\n` + esc(stale.join(", ")));
  }

  if (body.dry_run) {
    return json({ ok: true, dry_run: true, checked, stale: stale.length,
      findings, preview: blocks.join("\n\n") });
  }

  // Recorded before sending, and deduped on account + day + metric + kind, so
  // the three daily runs report a slump once rather than three times.
  const fresh: Finding[] = [];
  for (const f of findings) {
    const { data: existing } = await admin.from("agent_alerts")
      .select("id, sent_at")
      .eq("organization_id", orgId).eq("agent_slug", "selim")
      .eq("account_key", f.account_key).eq("day", f.day)
      .eq("metric", f.metric).eq("kind", f.kind).maybeSingle();
    if (existing?.sent_at) continue;
    fresh.push(f);
  }
  if (findings.length) {
    await admin.from("agent_alerts").upsert(
      findings.map(f => ({ organization_id: orgId, agent_slug: "selim", ...f })),
      { onConflict: "organization_id,agent_slug,account_key,day,metric,kind" },
    );
  }

  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  let sent = 0;
  // Nothing new since the last run is not worth a message: a channel that
  // repeats itself three times a day stops being read.
  const worthSending = fresh.length > 0;
  if (worthSending && token && chatId) {
    const freshBlocks: string[] = [blocks[0]];
    const fbad = fresh.filter(f => f.severity === "bad");
    const fwarn = fresh.filter(f => f.severity === "warn");
    if (fbad.length) freshBlocks.push(`🔴 <b>Needs a look (${fbad.length})</b>\n` + fbad.map(f => "• " + f.message).join("\n"));
    if (fwarn.length) freshBlocks.push(`🟠 <b>Worth a check (${fwarn.length})</b>\n` + fwarn.map(f => "• " + f.message).join("\n"));

    const chunks: string[] = [];
    let cur = "";
    for (const b of freshBlocks) {
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
    const ids = fresh.map(f => ({ account_key: f.account_key, day: f.day, metric: f.metric, kind: f.kind }));
    for (const k of ids) {
      await admin.from("agent_alerts").update({ sent_at: new Date().toISOString() })
        .eq("organization_id", orgId).eq("agent_slug", "selim")
        .eq("account_key", k.account_key).eq("day", k.day)
        .eq("metric", k.metric).eq("kind", k.kind);
    }
  }

  await admin.from("agents").update({
    last_run_at: new Date().toISOString(),
    last_run_note: `${checked} accounts · ${findings.length} findings · ${fresh.length} new · ${sent} message${sent === 1 ? "" : "s"}`
      + (token && chatId ? "" : " · Telegram not configured"),
  }).eq("organization_id", orgId).eq("slug", "selim");

  return json({ ok: true, checked, findings: findings.length, new: fresh.length,
    stale: stale.length, messages: sent,
    telegram: token && chatId ? "configured" : "missing" });
});
