/**
 * Daily report to Telegram
 *
 * One message at noon Cairo covering yesterday, a block per client: the day,
 * the month to date, and a read on how the day compares. The team fills the
 * previous day in Notion during the morning, so noon is late enough for the
 * figures to be there and early enough to act on them.
 *
 * Each block is written for the client's own template: a shop reports orders,
 * pieces, revenue and ROAS; an academy reports reservations; the donations
 * account reports donors; an awareness client reports delivery. A single fixed
 * shape would be meaningless for most of them.
 *
 * Where a sheet has not reached yesterday the client is listed as not filled
 * rather than shown as zeros. That is not a failure mode to hide -- it is also
 * the fastest way to see who is behind.
 *
 * The bot token is read from the environment and never appears here or in the
 * database. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID as Supabase secrets.
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

/**
 * Cairo's date and hour.
 *
 * Egypt puts the clocks forward again, so a fixed UTC hour would drift by one
 * hour twice a year. The cron fires at both candidate hours and this decides
 * which one is actually noon there, rather than hard-coding +2 or +3.
 */
function cairoNow(at = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map(p => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
  };
}

function shiftDate(ymd: string, days: number) {
  const d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const n = (v: unknown): number | null =>
  v == null || isNaN(Number(v)) ? null : Number(v);

const int = (v: number | null) =>
  v == null ? "—" : Math.round(v).toLocaleString("en");

const money = (v: number | null, cur: string) =>
  v == null ? "—" : `${cur}${v.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ratio = (a: number | null, b: number | null) =>
  (a != null && b) ? a / b : null;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type Row = Record<string, unknown>;

/**
 * Conversion spend, the same way the dashboard works it out.
 *
 * The named parts can only understate: a sheet is free to call a selling
 * campaign anything, and Retaj records theirs as "Muslima Spending". Where the
 * sheet keeps its own total, everything in it that is not branding is selling
 * spend, so the larger of the two is taken.
 */
function convSpend(r: Row): number | null {
  const parts = [r.web_spend, r.msg_spend, r.courses_spend, r.tahfez_spend].map(n);
  const anyPart = parts.some(v => v != null);
  const sum = anyPart ? parts.reduce<number>((s, v) => s + (v ?? 0), 0) : null;
  const total = n(r.total_spend);
  const lessBrand = total == null ? null : Math.max(0, total - (n(r.branding_spend) ?? 0));
  if (sum == null && lessBrand == null) return null;
  return Math.max(sum ?? 0, lessBrand ?? 0);
}

function totalSpend(r: Row): number | null {
  return n(r.total_spend) ?? convSpend(r);
}

function revenueOf(r: Row): number | null {
  return n(r.web_revenue_confirmed) ?? n(r.total_revenue) ?? n(r.web_revenue);
}

// null + value = value, so a column no day carried stays null rather than
// becoming a confident zero.
const add = (a: number | null, b: number | null) => b == null ? a : (a ?? 0) + b;

type Tally = {
  webOrders: number | null; webPieces: number | null;
  msgOrders: number | null; msgPieces: number | null;
  orders: number | null;    pieces: number | null;
  revenue: number | null;   spend: number | null;   totalSpend: number | null;
  msgs: number | null;      deals: number | null;   tahfez: number | null;
  leads: number | null;     donors: number | null;  clicks: number | null;
  engagement: number | null; reach: number | null;  impressions: number | null;
  days: number;
};

/**
 * Add up a set of days.
 *
 * Each day is reduced first and the results summed, rather than summing the
 * raw columns and reducing once. It matters: revenue falls back from confirmed
 * to total to website per day, and spend takes the larger of its two readings
 * per day. Doing that once over a month's totals would mix a confirmed figure
 * from one day with an unconfirmed one from another.
 */
function tally(rows: Row[]): Tally {
  const t: Tally = {
    webOrders: null, webPieces: null, msgOrders: null, msgPieces: null,
    orders: null, pieces: null, revenue: null, spend: null, totalSpend: null,
    msgs: null, deals: null, tahfez: null, leads: null, donors: null,
    clicks: null, engagement: null, reach: null, impressions: null, days: 0,
  };
  for (const r of rows) {
    t.days++;
    const wo = n(r.web_orders_confirmed) ?? n(r.web_orders);
    const wp = n(r.web_pieces_confirmed) ?? n(r.web_pieces);
    const mo = n(r.msg_orders);
    const mp = n(r.msg_pieces);
    t.webOrders = add(t.webOrders, wo);
    t.webPieces = add(t.webPieces, wp);
    t.msgOrders = add(t.msgOrders, mo);
    t.msgPieces = add(t.msgPieces, mp);
    t.orders    = add(t.orders, wo == null && mo == null ? null : (wo ?? 0) + (mo ?? 0));
    t.pieces    = add(t.pieces, wp == null && mp == null ? null : (wp ?? 0) + (mp ?? 0));
    t.revenue    = add(t.revenue, revenueOf(r));
    t.spend      = add(t.spend, convSpend(r));
    t.totalSpend = add(t.totalSpend, totalSpend(r));
    t.msgs       = add(t.msgs, n(r.msg_count));
    t.deals      = add(t.deals, n(r.deals_total));
    t.tahfez     = add(t.tahfez, n(r.total_tahfez));
    t.leads      = add(t.leads, n(r.leads_total));
    t.donors     = add(t.donors, n(r.donation_users));
    t.clicks     = add(t.clicks, n(r.clicks));
    t.engagement = add(t.engagement, n(r.engagement));
    t.reach      = add(t.reach, n(r.reach));
    t.impressions = add(t.impressions, n(r.impressions));
  }
  return t;
}

const pct = (a: number, b: number) => (a - b) / b * 100;
const signed = (v: number) => `${v >= 0 ? "+" : ""}${Math.round(v)}%`;

/**
 * The read on the day, in one or two sentences.
 *
 * Every clause is arithmetic on the client's own figures -- this day against
 * the average of the month's earlier days, and the month's pace against last
 * month's finished total. Nothing here is a guess: where there is no basis for
 * a comparison (a first day, a client with no revenue column) the comparison is
 * left out rather than filled in with something agreeable.
 */
function comment(
  template: string, dayT: Tally, mtd: Tally, prev: Tally,
  dayOfMonth: number, daysInMonth: number, cur: string,
): string {
  const parts: string[] = [];
  const spend = dayT.totalSpend ?? dayT.spend;
  const rev = dayT.revenue;

  // An awareness client has no revenue to be judged on, so the day is read
  // on delivery and cost instead.
  const revenueLed = template !== "awareness";

  if ((spend == null || spend === 0) && (rev == null || rev === 0)) {
    return "Nothing spent and nothing recorded this day.";
  }
  if (revenueLed && spend && (rev == null || rev === 0)) {
    parts.push(`⚠️ ${money(spend, cur)} spent with no revenue recorded.`);
  }

  // This day against the month's earlier days.
  const earlierDays = mtd.days - dayT.days;
  if (revenueLed && rev != null && mtd.revenue != null && earlierDays > 0) {
    const avg = (mtd.revenue - rev) / earlierDays;
    if (avg > 0) {
      const d = pct(rev, avg);
      parts.push(
        Math.abs(d) < 15
          ? `Revenue in line with the month's daily average (${money(avg, cur)}).`
          : `Revenue ${signed(d)} against the month's daily average of ${money(avg, cur)}.`,
      );
    }
  }

  // ROAS, where both sides exist.
  const dayRoas = ratio(rev, dayT.spend);
  const mtdRoas = ratio(mtd.revenue, mtd.spend);
  if (revenueLed && dayRoas != null) {
    if (dayRoas < 1) parts.push(`⚠️ ROAS ${dayRoas.toFixed(2)}x — the day returned less than it cost.`);
    else if (mtdRoas != null && Math.abs(dayRoas - mtdRoas) >= 0.3) {
      parts.push(`ROAS ${dayRoas.toFixed(2)}x against ${mtdRoas.toFixed(2)}x for the month so far.`);
    }
  }

  // Where the month lands if the rest of it looks like the part already run.
  // Three days is the floor: projecting a whole month from one filled day
  // produces a confident number with nothing behind it.
  if (revenueLed && mtd.revenue != null && dayOfMonth > 0 && mtd.days >= 3) {
    const projected = mtd.revenue / dayOfMonth * daysInMonth;
    if (prev.revenue != null && prev.revenue > 0) {
      const d = pct(projected, prev.revenue);
      const verdict = d >= 10 ? "ahead of" : d <= -10 ? "behind" : "level with";
      parts.push(
        `At this pace the month ends near ${money(projected, cur)}, ${verdict} last month's ${money(prev.revenue, cur)} (${signed(d)}).`,
      );
    } else {
      parts.push(`At this pace the month ends near ${money(projected, cur)}.`);
    }
  }

  if (!revenueLed) {
    const eng = dayT.engagement;
    const earlier = mtd.days - dayT.days;
    if (eng != null && mtd.engagement != null && earlier > 0) {
      const avg = (mtd.engagement - eng) / earlier;
      if (avg > 0) parts.push(`Engagement ${signed(pct(eng, avg))} against the month's daily average.`);
    }
    if (spend != null) parts.push(`${money(mtd.totalSpend ?? mtd.spend, cur)} spent this month so far.`);
  }

  return parts.length ? parts.join(" ") : "Recorded, with nothing to compare it against yet.";
}

/** "12 orders (18 pieces)", with the bracket dropped when the sheet has no pieces column. */
const op = (orders: number | null, pieces: number | null) =>
  `${int(orders)} orders` + (pieces == null ? "" : ` (${int(pieces)} pieces)`);

const roasOf = (rev: number | null, spend: number | null) => {
  const v = ratio(rev, spend);
  return v == null ? "\u2014" : v.toFixed(2) + "x";
};

/**
 * The body lines for one period, written for the client's own template.
 *
 * A shop is judged on orders and pieces, an academy on reservations, the
 * donations client on donors, an awareness client on delivery. The shape is
 * the same for all of them -- this day, this month, a comment -- and only
 * these middle lines differ.
 */
function bodyFor(template: string, t: Tally, cur: string, monthly: boolean): string[] {
  const out: string[] = [];
  const spend = t.totalSpend ?? t.spend;

  switch (template) {
    case "education":
      out.push(`Messages = ${int(t.msgs)}`);
      out.push(`Reservations = ${int(t.deals)}` +
        (t.tahfez == null ? "" : ` (${int(t.tahfez)} tahfez)`));
      break;
    case "messages-service":
      out.push(`Messages = ${int(t.msgs)}`);
      if (t.leads != null) out.push(`Leads = ${int(t.leads)}`);
      out.push(`Deals = ${int(t.deals)}`);
      break;
    case "donations":
      out.push(`Messages = ${int(t.msgs)}`);
      if (t.clicks != null) out.push(`Clicks = ${int(t.clicks)}`);
      out.push(`Donors = ${int(t.donors)}`);
      break;
    case "awareness":
      if (t.reach != null)       out.push(`Reach = ${int(t.reach)}`);
      if (t.impressions != null) out.push(`Impressions = ${int(t.impressions)}`);
      if (t.engagement != null)  out.push(`Engagement = ${int(t.engagement)}`);
      break;
    case "messages":
      out.push(`Messages = ${op(t.msgOrders, t.msgPieces)}`);
      break;
    default: {
      // full, google-ads and anything unset: the shape Selim wrote out.
      //
      // A channel the sheet has no column for is left off rather than printed
      // as "— orders". Ibriz sells through the website only, and a Messages
      // line with a dash in it reads as a broken figure rather than as a
      // channel the client does not use.
      const hasWeb = t.webOrders != null || t.webPieces != null;
      const hasMsg = t.msgOrders != null || t.msgPieces != null;
      if (hasWeb) out.push(`Website = ${op(t.webOrders, t.webPieces)}`);
      if (hasMsg) out.push(`Messages = ${op(t.msgOrders, t.msgPieces)}`);
      if (hasWeb && hasMsg) {
        out.push(`${monthly ? "Total" : "Total Sales"} = ${op(t.orders, t.pieces)}`);
      } else if (!hasWeb && !hasMsg) {
        out.push(`${monthly ? "Total" : "Total Sales"} = ${op(null, null)}`);
      }
      break;
    }
  }

  out.push(`${monthly ? "Total Spending" : "Spending"} = ${money(spend, cur)}`);
  if (template !== "awareness") {
    out.push(`${monthly ? "Total Revenue" : "Revenue"} = ${money(t.revenue, cur)}`);
    out.push(`ROAS = ${roasOf(t.revenue, t.spend)}`);
  }
  return out;
}

/** One client's whole block: the day, the month to date, and the read on it. */
function blockFor(
  template: string, name: string, cur: string,
  dayT: Tally, mtd: Tally, prev: Tally,
  dayOfMonth: number, daysInMonth: number,
): string {
  return [
    `<b>Brand: ${esc(name)}</b>`,
    "",
    "<i>This day</i>",
    ...bodyFor(template, dayT, cur, false),
    "",
    "<i>This month</i>",
    ...bodyFor(template, mtd, cur, true),
    "",
    `\u{1F4AC} ${esc(comment(template, dayT, mtd, prev, dayOfMonth, daysInMonth, cur))}`,
  ].join("\n");
}

async function send(token: string, chatId: string, text: string) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    // Telegram puts the reason in the body, and it is almost always the chat id
    // or the bot not being in the group. Worth surfacing rather than a bare 400.
    throw new Error(`Telegram ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return await res.json();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  let body: { cron_secret?: string; dry_run?: boolean; day?: string; force?: boolean;
              check?: boolean; discover?: boolean };
  try { body = await req.json(); } catch { body = {}; }

  // The cron presents the same shared secret the Notion sync uses.
  const { data: secret } = await admin
    .from("app_secrets").select("value").eq("key", "notion_cron").maybeSingle();
  if (!secret?.value || secret.value !== body.cron_secret) {
    return json({ error: "Unauthorized" }, 401);
  }

  // Read after the body, not before it: these checks consult body.dry_run, and
  // a let declared further down is in its temporal dead zone until then, so
  // touching it first throws on every single call.
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  // A dry run is still useful without the bot configured: it is how the report
  // can be read before anyone creates it.
  if ((!token || !chatId) && !body.dry_run) {
    return json({
      error: "NO_TELEGRAM_CONFIG",
      hint: "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID as Supabase secrets. " +
            "Create the bot with @BotFather, add it to the group, and read the chat id from " +
            "https://api.telegram.org/bot<token>/getUpdates after posting once in that group.",
    }, 422);
  }

  // Find the chat id without anyone having to build a getUpdates URL by hand.
  //
  // The documented way to get a chat id is to open
  // api.telegram.org/bot<TOKEN>/getUpdates in a browser, and that goes wrong
  // easily: the angle brackets get left in, the token gets pasted into the
  // wrong part of the URL, and the token ends up in a browser history and a
  // screenshot. The function already holds the token, so it can just ask.
  //
  // A chat id is not a credential -- it is useless without the bot token --
  // so returning it here is safe, and it is the one value that has to be
  // copied into the secret.
  if (body.discover) {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates?limit=100&allowed_updates=${encodeURIComponent(JSON.stringify(["message","channel_post","my_chat_member"]))}`,
    );
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      return json({ error: "TELEGRAM_GETUPDATES_FAILED",
                    detail: (payload as { description?: string })?.description ?? res.status }, 502);
    }
    // deno-lint-ignore no-explicit-any
    const updates = ((payload as any)?.result ?? []) as any[];
    const seen = new Map<string, Record<string, unknown>>();
    for (const u of updates) {
      const c = u?.message?.chat ?? u?.channel_post?.chat ?? u?.my_chat_member?.chat;
      if (!c?.id) continue;
      seen.set(String(c.id), {
        chat_id: String(c.id),
        type: c.type ?? null,
        title: c.title ?? ([c.first_name, c.last_name].filter(Boolean).join(" ") || null),
        use_this_for_the_group: String(c.id).startsWith("-"),
      });
    }
    return json({
      ok: true, discover: true,
      bot: "@Blueaddashboard_bot",
      chats_found: [...seen.values()],
      note: seen.size
        ? "Copy chat_id of the group you want into TELEGRAM_CHAT_ID."
        : "Telegram has no recent updates for this bot. Add it to the group and post a " +
          "message there (or press Start in a private chat), then run this again. " +
          "Telegram only keeps updates for about 24 hours.",
    });
  }

  // Ask Telegram what it thinks of the bot and the chat, without sending
  // anything. Returns the bot's username and the chat's type and title -- not
  // the chat id, which is a secret value and does not need echoing back to
  // establish whether it points at the right group.
  if (body.check) {
    const call = async (method: string, qs = "") => {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}${qs}`);
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const me = await call("getMe");
    const chat = await call("getChat", `?chat_id=${encodeURIComponent(chatId!)}`);
    // deno-lint-ignore no-explicit-any
    const c = (chat.body as any)?.result;
    return json({
      ok: true,
      check: true,
      // deno-lint-ignore no-explicit-any
      bot: (me.body as any)?.result?.username ?? null,
      bot_error: me.status === 200 ? null : (me.body as { description?: string })?.description ?? me.status,
      chat_reachable: chat.status === 200,
      chat_type: c?.type ?? null,
      chat_title: c?.title ?? null,
      chat_error: chat.status === 200 ? null
        : (chat.body as { description?: string })?.description ?? chat.status,
      chat_id_shape: chatId
        ? (/^-100\d+$/.test(chatId) ? "supergroup/channel id (-100…)"
          : /^-\d+$/.test(chatId) ? "basic group id (negative)"
          : /^\d+$/.test(chatId) ? "positive id — this is a private user, not a group"
          : chatId.startsWith("@") ? "public @username"
          : "not an id or @username")
        : null,
    });
  }

  // The cron fires at both hours that could be noon in Cairo across the year;
  // this is the half that decides which one actually is. force skips it so the
  // report can be sent by hand at any time.
  const now = cairoNow();
  if (!body.force && !body.dry_run && now.hour !== 12) {
    return json({ ok: true, skipped: true, reason: `Cairo hour is ${now.hour}, not 12` });
  }

  const day = body.day || shiftDate(now.date, -1);

  // Only accounts with a sheet. An active account with no Notion page has
  // nothing to report and listing it as "not filled in Notion yet" is simply
  // untrue -- the first run said that about 79 of them, which buries the few
  // that genuinely are behind.
  const { data: accounts } = await admin
    .from("meta_ad_accounts")
    .select("id, account_name, currency, dashboard_template, notion_url")
    .eq("is_active", true)
    .not("notion_url", "is", null)
    .order("account_name");

  // The day itself, the month up to and including it, and last month whole.
  // The month figures are what make the day mean anything: 17 orders is only
  // good or bad against what the other days came to.
  const monthStart = day.slice(0, 8) + "01";
  const prevMonthEnd = shiftDate(monthStart, -1);
  const prevMonthStart = prevMonthEnd.slice(0, 8) + "01";
  const dayOfMonth = Number(day.slice(8, 10));
  const daysInMonth = new Date(Date.UTC(
    Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).getUTCDate();

  const [{ data: mtdRows }, { data: prevRows }] = await Promise.all([
    admin.from("notion_daily").select("*").gte("day", monthStart).lte("day", day),
    admin.from("notion_daily").select("*").gte("day", prevMonthStart).lte("day", prevMonthEnd),
  ]);

  const byAccount: Record<string, Row> = {};
  const mtdBy: Record<string, Row[]> = {};
  const prevBy: Record<string, Row[]> = {};
  for (const r of mtdRows ?? []) {
    const k = String((r as Row).account_key);
    (mtdBy[k] ||= []).push(r as Row);
    if (String((r as Row).day).slice(0, 10) === day) byAccount[k] = r as Row;
  }
  for (const r of prevRows ?? []) {
    (prevBy[String((r as Row).account_key)] ||= []).push(r as Row);
  }

  const { data: groups } = await admin
    .from("account_groups")
    .select("id, name, account_ids, dashboard_template, notion_url")
    .not("notion_url", "is", null)
    .order("name");

  // One block per client, not per ad account.
  //
  // Ibriz runs two ad accounts against a single Notion sheet, and so do Nuya
  // and Retaj. That sheet has one row per day for the whole client, with
  // nothing saying which account an order came from -- so the figures are the
  // client's. Reporting them per account printed the same 17 orders under
  // BlueAd1, again under BlueAd2, and a third time under Combined, which reads
  // as 51 orders to anyone totalling the column.
  //
  // Accounts are therefore grouped by the sheet they share. Where a client has
  // one account this changes nothing at all.
  const byUrl = new Map<string, Row[]>();
  for (const a of (accounts ?? []) as Row[]) {
    const url = String(a.notion_url ?? "").trim();
    if (!byUrl.has(url)) byUrl.set(url, []);
    byUrl.get(url)!.push(a);
  }
  const groupByUrl = new Map<string, Row>();
  for (const g of (groups ?? []) as Row[]) {
    groupByUrl.set(String(g.notion_url ?? "").trim(), g);
  }

  const withData: { name: string; line: string }[] = [];
  const noData: string[] = [];

  for (const [url, accts] of byUrl) {
    const g = groupByUrl.get(url);
    // The sheet's own figures live on the group row where a group exists, and
    // on the account row otherwise. They are the same numbers either way --
    // the group row is preferred because it is the one keyed to the client.
    const groupKey = g ? "__group__" + String(g.id) : null;
    const key = (groupKey && byAccount[groupKey]) ? groupKey : String(accts[0].id);
    const r = byAccount[key];
    // The month and last month are read from whichever key the day came from,
    // so a client never has its day measured against another key's month.
    const mtdKey = (groupKey && mtdBy[groupKey]?.length) ? groupKey : String(accts[0].id);

    // The client's name: the group's where there is one, otherwise the
    // shortest account name, which is reliably the name without the "2" or
    // the agency suffix ("Retaj" out of Retaj and Retaj 2).
    const name = g
      ? String(g.name ?? "Client")
      : accts.map(a => String(a.account_name ?? "").trim())
             .filter(Boolean)
             .sort((x, y) => x.length - y.length)[0] ?? "Account";

    const label = accts.length > 1 ? `${name} · ${accts.length} ad accounts` : name;
    const cur = accts.map(a => a.currency ? String(a.currency) + " " : "").find(Boolean) ?? "";
    const tmpl = String(g?.dashboard_template ?? accts[0].dashboard_template ?? "full");

    if (!r) { noData.push(label); continue; }
    withData.push({ name, line: blockFor(
      tmpl, label, cur,
      tally([r]), tally(mtdBy[mtdKey] ?? []), tally(prevBy[mtdKey] ?? []),
      dayOfMonth, daysInMonth) });
  }

  // A group whose sheet no account carries -- nothing should fall through
  // silently just because the link lives only on the group.
  for (const [url, g] of groupByUrl) {
    if (byUrl.has(url)) continue;
    const gk = "__group__" + String(g.id);
    const r = byAccount[gk];
    const name = String(g.name ?? "Client");
    if (!r) { noData.push(name); continue; }
    withData.push({ name, line: blockFor(
      String(g.dashboard_template ?? "full"), name, "",
      tally([r]), tally(mtdBy[gk] ?? []), tally(prevBy[gk] ?? []),
      dayOfMonth, daysInMonth) });
  }

  withData.sort((a, b) => a.name.localeCompare(b.name));
  noData.sort((a, b) => a.localeCompare(b));

  const human = new Date(day + "T12:00:00Z")
    .toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  // The blocks, kept as a list rather than one string, because the splitter
  // below has to break between clients and a client's own block now contains
  // blank lines. Splitting the finished text on "\n\n" would cut a client in
  // half, between "This day" and "This month".
  const blocks: string[] = [`📊 <b>Blue Ad — ${esc(human)}</b>`];
  if (withData.length) blocks.push(...withData.map(w => w.line));
  else blocks.push("No client has figures for this day yet.");
  if (noData.length) {
    blocks.push(`<i>Sheet not filled for this day (${noData.length}):</i>\n` +
                esc(noData.join(", ")));
  }
  const text = blocks.join("\n\n");

  // Telegram refuses a message over 4096 characters, and silently losing the
  // tail would be worse than sending several.
  //
  // The first version cut every 3800 characters wherever that landed, which
  // can fall inside a <b> tag -- and Telegram rejects a message whose HTML
  // does not parse, so the report would have failed outright rather than
  // arriving split. Whole blocks only now.
  const chunks: string[] = [];
  {
    const LIMIT = 3500;
    let cur = "";
    for (const block of blocks) {
      const joined = cur ? cur + "\n\n" + block : block;
      if (joined.length > LIMIT && cur) { chunks.push(cur); cur = block; }
      else cur = joined;
    }
    if (cur) chunks.push(cur);
  }

  if (body.dry_run) {
    return json({ ok: true, dry_run: true, day, clients_with_data: withData.length,
                  clients_without: noData.length,
                  chunks: chunks.length, configured: !!(token && chatId),
                  // Which half is missing, and the NAMES of any Telegram
                  // variables that are set -- never their values. "configured:
                  // false" on its own cannot tell a typo in a secret's name
                  // apart from a secret that was never added, and those need
                  // different fixes.
                  has_token: !!token, has_chat_id: !!chatId,
                  telegram_env_names: Object.keys(Deno.env.toObject())
                    .filter(k => /telegram/i.test(k)).sort(),
                  preview: text });
  }

  // A throw here used to escape the handler, so a rejected message came back
  // as a bare "Internal Server Error" with Telegram's actual reason only in
  // the logs. The reason is almost always fixable in a minute -- the chat id
  // or the bot not being in the group -- so it belongs in the response.
  const sent = [];
  try {
    for (const c of chunks) sent.push(await send(token!, chatId!, c));
  } catch (e) {
    return json({
      error: "TELEGRAM_SEND_FAILED",
      detail: (e as Error).message,
      sent_before_failure: sent.length,
      hint: "\"chat not found\" means TELEGRAM_CHAT_ID does not name a chat this bot " +
            "can post to: either the bot was never added to the group, or the id is " +
            "wrong. Call this function with {\"check\":true} to ask Telegram directly.",
    }, 502);
  }
  return json({ ok: true, day, clients_with_data: withData.length,
                clients_without: noData.length, messages: sent.length });
});
