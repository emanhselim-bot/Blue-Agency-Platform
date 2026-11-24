/**
 * agent-selim — Supabase Edge Function
 *
 * Selim is the performance media buyer who never goes home. Twice a day —
 * 13:00 and 23:00 Cairo — he reads what every live account has done
 * **today** and compares it with what that account normally does, over the
 * previous three months. When today is off — fewer results, or each result
 * costing more — he says so in Telegram, with the two numbers side by side.
 *
 * ── Why today, and why live ───────────────────────────────────────
 *
 * The first version compared yesterday out of the team's Notion sheet. That
 * sheet is filled a day or two behind, so "yesterday" was often three days
 * ago: by the time it complained, the money was spent. Today's figures come
 * from Meta directly, through meta-platform, so a campaign that broke this
 * morning is caught this morning.
 *
 * The three-month baseline still comes from the sheet. It is the team's own
 * reconciled history — the same figures the dashboard reports — and over 90
 * days a day or two of lag makes no difference to an average.
 *
 * ── Comparing part of a day with a whole one ──────────────────────
 *
 * At 10:00 every account on earth is "down 80%", because the day is a third
 * old. So:
 *
 *   Cost per result is compared directly. It is a ratio — EGP 180 per order
 *   is EGP 180 per order whether the day is half done or finished.
 *
 *   Volume is compared against the share of the day that has passed. At
 *   15:00 an account that normally does 12 orders a day is expected to be
 *   around 6, not 12.
 *
 * That is also why the late run is the one that matters most: by 23:00
 * the day is nearly complete and the comparison is nearly exact.
 *
 * ── What counts as a result ───────────────────────────────────────
 *
 * Whatever the account is buying: purchases for a shop, leads for a lead
 * account, conversations for a client who sells in the inbox. Meta names
 * these differently per objective, so the first action type that actually
 * came back is used and the alarm says which one it counted.
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
const BATCH = 4;               // Meta calls in flight at once
const PAUSE = 250;             // breathing room between batches, in ms
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const num = (v: unknown) => { const n = Number(v); return isFinite(n) ? n : 0; };
const pct = (a: number, b: number) => b ? (a - b) / b * 100 : null;
const money = (v: number, cur: string) => `${cur ? cur + " " : ""}${Math.round(v).toLocaleString("en")}`;
const niceDay = (ymd: string) =>
  new Date(ymd + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

/** Cairo's own date, hour and minute — Egypt moves its clocks. */
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

type Row = Record<string, unknown>;

/* ── The sheet, for the baseline ──────────────────────────────────── */

function spendOf(r: Row) {
  const total = num(r.total_spend);
  if (total > 0) return total;
  return num(r.web_spend) + num(r.msg_spend) + num(r.branding_spend)
    + num(r.engagement_spend) + num(r.follow_spend) + num(r.profile_visit_spend)
    + num(r.courses_spend) + num(r.tahfez_spend) + num(r.tiktok_spend);
}
const ordersOf = (r: Row) => num(r.web_orders) + num(r.msg_orders);
const leadsOf  = (r: Row) => num(r.leads_total) || num(r.deals_total);

/* ── Meta, for today ──────────────────────────────────────────────── */

// One list per objective, first match wins. Meta renames these between API
// versions and uses different ones per objective, so the count is taken from
// whichever name actually came back, and the name is reported with it.
const RESULT_KEYS: [string, string[]][] = [
  ["purchase", ["purchase", "offsite_conversion.fb_pixel_purchase", "omni_purchase", "onsite_web_purchase"]],
  ["lead", ["lead", "offsite_conversion.fb_pixel_lead", "onsite_conversion.lead_grouped"]],
  ["conversation", ["onsite_conversion.messaging_conversation_started_7d", "onsite_conversion.total_messaging_connection"]],
  ["add to cart", ["add_to_cart", "offsite_conversion.fb_pixel_add_to_cart"]],
];

type Today = { spend: number; results: number; kind: string; ok: boolean };

// One retry, because a failed lookup is indistinguishable from a quiet
// account and the quiet reading is the dangerous one: an account that was
// burning money would be reported as fine. A second failure is reported as
// unreadable rather than guessed at.
async function metaToday(accountId: string, secret: string, attempt = 0): Promise<Today> {
  try {
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/meta-platform`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_db_id: accountId, cron_secret: secret, period: "today" }),
      signal: AbortSignal.timeout(40_000),
    });
    if (!r.ok) {
      if (attempt === 0) {
        await new Promise(res => setTimeout(res, 800));
        return metaToday(accountId, secret, 1);
      }
      return { spend: 0, results: 0, kind: "", ok: false };
    }
    const j = await r.json();
    const rows = (j.platforms ?? []) as Row[];
    let spend = 0;
    const actions: Record<string, number> = {};
    for (const p of rows) {
      spend += num(p.spend);
      const all = (p.actions_all ?? {}) as Record<string, string>;
      for (const [k, v] of Object.entries(all)) actions[k] = (actions[k] ?? 0) + num(v);
    }
    for (const [label, keys] of RESULT_KEYS) {
      for (const k of keys) {
        if (actions[k] > 0) return { spend, results: actions[k], kind: label, ok: true };
      }
    }
    return { spend, results: 0, kind: "", ok: true };
  } catch {
    if (attempt === 0) {
      await new Promise(res => setTimeout(res, 800));
      return metaToday(accountId, secret, 1);
    }
    return { spend: 0, results: 0, kind: "", ok: false };
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

  // Two ways in: the cron secret for the scheduled run, or a signed-in member
  // asking for a preview. A preview never sends and never writes, so it
  // cannot be used to spam the channel.
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
  if (!secret) return json({ error: "No cron secret configured" }, 500);

  // Finding the id of Selim's own chat, without anybody handling the bot
  // token. Create the group, add the bot, say anything in it, then call this:
  // Telegram hands back the recent conversations and the id goes into the
  // agent's settings. Cron secret only, and it reads nothing but chat names.
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
        id: Number(chat.id),
        type: String(chat.type ?? ""),
        title: String(chat.title ?? chat.username ?? chat.first_name ?? ""),
      });
    }
    return json({ ok: true, chats: [...seen.values()] });
  }

  const now = cairoNow();
  const today = body.day || now.date;
  // How much of the day has gone, so a part-day is not judged as a whole one.
  //
  // Not floored. An earlier version held it at a fifth to stop the
  // expectation going to nothing, which had it demanding a fifth of the
  // day's orders at ten past midnight — every account "down 100%" before
  // anyone was awake. Instead the volume comparison is simply not made
  // before a third of the day has passed; the scheduled runs are at 10:00,
  // 13:00 and 23:00, so both clear it.
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
  const s_watch = settings.watch as unknown[] | undefined;
  const DROP = s.drop_pct ?? 35;          // results under the expected share
  const RISE = s.cost_rise_pct ?? 35;     // cost per result over the baseline
  const MIN_RESULTS = s.min_orders ?? 3;  // results/day in the baseline to judge volume
  const MIN_SPEND = s.min_spend ?? 300;   // today's spend worth an alarm
  const BASE_DAYS = s.base_days ?? 90;    // the three months behind today

  // The hours he reports at, in Cairo.
  //
  // Egypt puts its clocks forward in summer, so a UTC cron cannot name a
  // Cairo hour on its own. The job fires at both UTC hours each slot can
  // fall on across the year and this is what decides whether it is really
  // one of them — the same arrangement the older Telegram jobs use. A dry
  // run ignores it, because a preview is asked for by a person.
  const hours = (Array.isArray(settings.hours) ? settings.hours : [13, 23]).map(Number);
  if (!body.dry_run && !body.force && !hours.includes(now.hour)) {
    return json({ ok: true, skipped: true, reason: `Cairo hour is ${now.hour}, not one of ${hours.join(", ")}` });
  }

  const { data: accounts } = await admin.from("meta_ad_accounts")
    .select("id, account_name, currency").eq("organization_id", orgId).eq("is_active", true);
  const live = (accounts ?? []) as Row[];

  // ── The baseline: three months out of the sheet, per account ──────
  const base = new Map<string, { spend: number; results: number; days: number }>();
  const since = shift(today, -BASE_DAYS);
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from("notion_daily")
      .select("account_key, day, total_spend, web_spend, msg_spend, branding_spend, engagement_spend,"
        + " follow_spend, profile_visit_spend, courses_spend, tahfez_spend, tiktok_spend,"
        + " web_orders, msg_orders, leads_total, deals_total")
      .eq("organization_id", orgId)
      .gte("day", since).lt("day", today)
      .order("day", { ascending: true })
      .range(from, from + 999);
    if (error) return json({ error: error.message }, 500);
    for (const r of data ?? []) {
      const key = String(r.account_key);
      const spend = spendOf(r as Row);
      const results = ordersOf(r as Row) || leadsOf(r as Row);
      if (!spend && !results) continue;       // a blank row is not a quiet day
      const cur = base.get(key) ?? { spend: 0, results: 0, days: 0 };
      cur.spend += spend; cur.results += results; cur.days++;
      base.set(key, cur);
    }
    if (!data || data.length < 1000) break;
    if (from > 60000) break;
  }

  // ── Who gets watched ──────────────────────────────────────────────
  //
  // The list on the agent, which is the agency's own list of live clients.
  // That is a judgement nobody can infer from the data: an account with no
  // rows this quarter may be a client who starts next week, and one with
  // plenty of rows may have left. It is settings rather than code so the
  // list can change without a deploy.
  //
  // Falling back to "anything the sheet has touched" matters: it is what
  // stops a cleared or mistyped list leaving Selim watching nothing at all.
  // Either way the fan-out stays small — asking Meta about all 99 active
  // accounts on every run pushed most answers past their timeout, and
  // an account that cannot be read looks exactly like one that is behaving.
  const chosen = Array.isArray(s_watch) ? s_watch.map(String) : [];
  const watch = chosen.length
    ? live.filter(a => chosen.includes(String(a.id)))
    : live.filter(a => (base.get(String(a.id))?.days ?? 0) > 0);
  const dormant = live.length - watch.length;

  const todays = new Map<string, Today>();
  for (let i = 0; i < watch.length; i += BATCH) {
    const slice = watch.slice(i, i + BATCH);
    const out = await Promise.all(slice.map(a => metaToday(String(a.id), secret)));
    slice.forEach((a, n) => todays.set(String(a.id), out[n]));
    if (i + BATCH < watch.length) await new Promise(r => setTimeout(r, PAUSE));
  }

  const findings: Finding[] = [];
  const unreadable: string[] = [];
  let checked = 0, spending = 0;

  for (const a of watch) {
    const key = String(a.id);
    const name = String(a.account_name ?? key).trim();
    const cur = String(a.currency ?? "");
    const t = todays.get(key);
    if (!t) continue;
    if (!t.ok) { unreadable.push(name); continue; }
    checked++;
    // Nothing spent today is not a story — a paused account is a decision,
    // not a decline.
    if (t.spend <= 0) continue;
    spending++;

    const b = base.get(key);
    const baseResults = b && b.days ? b.results / b.days : 0;   // per day
    const baseSpend = b && b.days ? b.spend / b.days : 0;       // per day
    const baseCpr = b && b.results ? b.spend / b.results : 0;
    const todayCpr = t.results ? t.spend / t.results : 0;
    const expected = baseResults * dayShare;
    const add = (f: Omit<Finding, "account_key" | "account_name" | "day">) =>
      findings.push({ account_key: key, account_name: name, day: today, ...f });
    const asOf = `${String(now.hour).padStart(2, "0")}:00`;

    // 1. Money going out with nothing coming back.
    //
    // Measured against the account's own day as well as a flat floor: on a
    // client that spends 40,000 a day, 300 spent by mid-morning with no
    // orders is a slow start, not an emergency. A quarter of the normal
    // daily spend with nothing to show for it is the real thing.
    const wasteFloor = Math.max(MIN_SPEND, baseSpend * 0.25 * Math.max(dayShare, 0.25));
    if (t.results === 0 && t.spend >= wasteFloor) {
      add({ metric: "results", kind: "waste", severity: "bad",
        value: 0, baseline: baseResults || null, baseline_long: baseCpr || null,
        message: `${esc(name)} — ${money(t.spend, cur)} spent by ${asOf}, no results yet`
          + (baseResults ? ` · normally ${baseResults.toFixed(1)}/day` : "") });
      continue;   // the cost-per-result alarm below would say the same thing
    }

    // 2. Each result costing more than it has for three months. The headline
    //    comparison, and the one that holds at any hour.
    const risePct = pct(todayCpr, baseCpr);
    if (baseCpr > 0 && todayCpr > 0 && risePct != null && risePct >= RISE && t.spend >= MIN_SPEND) {
      add({ metric: "cost_per_result", kind: "cost", severity: "bad",
        value: todayCpr, baseline: baseCpr, baseline_long: baseResults || null,
        message: `${esc(name)} — ${money(todayCpr, cur)} per ${t.kind || "result"} by ${asOf}, `
          + `up ${risePct.toFixed(0)}% on the 3-month ${money(baseCpr, cur)}`
          + ` · ${t.results} ${t.kind || "result"}${t.results === 1 ? "" : "s"} on ${money(t.spend, cur)}` });
    }

    // 3. Fewer results than the day should have produced by now.
    const volPct = pct(t.results, expected);
    if (dayShare >= VOLUME_FROM && baseResults >= MIN_RESULTS && expected >= 1
        && volPct != null && volPct <= -DROP) {
      add({ metric: "results", kind: "drop", severity: "bad",
        value: t.results, baseline: expected, baseline_long: baseResults,
        message: `${esc(name)} — ${t.results} ${t.kind || "result"}${t.results === 1 ? "" : "s"} by ${asOf}, `
          + `against ${expected.toFixed(1)} expected by this hour `
          + `(3-month average ${baseResults.toFixed(1)}/day)` });
    }

    // 4. An account Selim cannot judge: spending today with no history to
    //    compare against. Said once, quietly, because it is a gap in the
    //    sheet rather than a problem with the account.
    if (!b || b.days < 14) {
      add({ metric: "baseline", kind: "trend", severity: "warn",
        value: t.spend, baseline: null, baseline_long: null,
        message: `${esc(name)} — spending ${money(t.spend, cur)} today but only `
          + `${b?.days ?? 0} days in the sheet over three months, so there is nothing to compare with` });
    }
  }

  const bad = findings.filter(f => f.severity === "bad");
  const warn = findings.filter(f => f.severity === "warn");

  const head = `🧭 <b>Selim</b> · today ${esc(niceDay(today))} at ${String(now.hour).padStart(2, "0")}:00 `
    + `· ${spending} accounts spending`;
  const blocks: string[] = [head];
  if (bad.length) blocks.push(`🔴 <b>Off their 3-month normal (${bad.length})</b>\n` + bad.map(f => "• " + f.message).join("\n"));
  if (warn.length) blocks.push(`🟠 <b>Cannot be judged yet (${warn.length})</b>\n` + warn.map(f => "• " + f.message).join("\n"));
  if (!findings.length) blocks.push(`✅ Nothing off trend. ${spending} accounts spending, all within their usual range.`);
  if (unreadable.length) {
    blocks.push(`<i>Meta would not answer for (${unreadable.length}):</i>\n` + esc(unreadable.join(", ")));
  }
  if (dormant) {
    blocks.push(`<i>${dormant} other active ad accounts are not on the watch list.</i>`);
  }

  if (body.dry_run) {
    return json({ ok: true, dry_run: true, checked, spending, dormant,
      day_share: Number(dayShare.toFixed(2)),
      unreadable: unreadable.length, findings, preview: blocks.join("\n\n") });
  }

  // Recorded before sending and deduped on account + day + metric + kind, so
  // the three runs report the same slump once. A cost alarm that was sent at
  // 10:00 is not sent again at 15:00 — but if the account's cost per result
  // recovers and slips again tomorrow, tomorrow is a new day and a new row.
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
  // Selim has his own chat. The agency channel carries the daily report and
  // the website watch; performance alarms on top of those
  // is how a channel stops being read. The id lives in settings beside the
  // watch list — it is not a credential, and keeping it there means the
  // chat can be changed without touching the project's secrets. Falls back
  // to the shared channel only if no chat of his own has been set.
  const chatId = String(settings.telegram_chat_id ?? "") || Deno.env.get("TELEGRAM_CHAT_ID");
  let sent = 0;
  if (fresh.length && token && chatId) {
    const fbad = fresh.filter(f => f.severity === "bad");
    const fwarn = fresh.filter(f => f.severity === "warn");
    const freshBlocks = [head];
    if (fbad.length) freshBlocks.push(`🔴 <b>Off their 3-month normal (${fbad.length})</b>\n` + fbad.map(f => "• " + f.message).join("\n"));
    if (fwarn.length) freshBlocks.push(`🟠 <b>Cannot be judged yet (${fwarn.length})</b>\n` + fwarn.map(f => "• " + f.message).join("\n"));

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
    for (const f of fresh) {
      await admin.from("agent_alerts").update({ sent_at: new Date().toISOString() })
        .eq("organization_id", orgId).eq("agent_slug", "selim")
        .eq("account_key", f.account_key).eq("day", f.day)
        .eq("metric", f.metric).eq("kind", f.kind);
    }
  }

  await admin.from("agents").update({
    last_run_at: new Date().toISOString(),
    last_run_note: `${spending} spending · ${findings.length} findings · ${fresh.length} new · ${sent} message${sent === 1 ? "" : "s"}`
      + (token && chatId ? "" : " · Telegram not configured"),
  }).eq("organization_id", orgId).eq("slug", "selim");

  return json({ ok: true, checked, spending, findings: findings.length, new: fresh.length,
    unreadable: unreadable.length, messages: sent,
    chat: settings.telegram_chat_id ? "own" : "shared",
    telegram: token && chatId ? "configured" : "missing" });
});
