/**
 * Daily report to Telegram
 *
 * One message at noon Cairo covering yesterday, a line or two per account.
 * The team fills the previous day in Notion during the morning, so noon is
 * late enough for the figures to be there and early enough to act on them.
 *
 * Each line is written for the account's own template: a shop reports orders,
 * revenue and ROAS; an academy reports reservations and cost per reservation;
 * the donations account reports donors. A single fixed row would be meaningless
 * for most of them.
 *
 * Where a sheet has not reached yesterday the line says so rather than showing
 * zeros. That is not a failure mode to hide -- it is also the fastest way to
 * see who has not filled their sheet in.
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

/** One account's line, written for its own template. */
function lineFor(template: string, name: string, cur: string, r: Row): string {
  const bits: string[] = [];
  const rev = revenueOf(r);
  const conv = convSpend(r);
  const tot = totalSpend(r);
  const msgs = n(r.msg_count);

  const roas = (d: number | null) => {
    const v = ratio(rev, d);
    return v == null ? "—" : v.toFixed(2) + "x";
  };

  switch (template) {
    case "donations": {
      const donors = n(r.donation_users);
      bits.push(`💬 ${int(msgs)}`);
      bits.push(`🤲 ${int(donors)} donors`);
      bits.push(`💰 ${money(tot, cur)}`);
      bits.push(`CPR ${money(ratio(tot, donors), cur)}`);
      bits.push(`ROAS ${roas(tot)}`);
      break;
    }
    case "education": {
      const reservations = n(r.deals_total);
      const tahfez = n(r.total_tahfez);
      bits.push(`💬 ${int(msgs)}`);
      bits.push(`🎓 ${int(reservations)} res` + (tahfez != null ? ` (${int(tahfez)} tahfez)` : ""));
      bits.push(`💰 ${money(tot, cur)}`);
      bits.push(`CPR ${money(ratio(tot, reservations), cur)}`);
      bits.push(`ROAS ${roas(tot)}`);
      break;
    }
    case "messages-service": {
      const leads = n(r.leads_total);
      const deals = n(r.deals_total);
      bits.push(`💬 ${int(msgs)}`);
      if (leads != null) bits.push(`📋 ${int(leads)} leads`);
      bits.push(`🤝 ${int(deals)} deals`);
      bits.push(`💰 ${money(tot, cur)}`);
      bits.push(`ROAS ${roas(n(r.msg_spend))}`);
      break;
    }
    case "awareness": {
      // Only what the sheet actually carries. The first version pushed every
      // figure whether or not it existed, so Fastum -- whose sheet holds spend
      // and nothing else -- reported "— engagement · — follows", which reads
      // like a collapse rather than a sheet with two columns in it.
      const impr = n(r.impressions);
      const rch  = n(r.reach);
      const eng  = n(r.engagement);
      const fol  = (n(r.follows_fb) ?? 0) + (n(r.follows_ig) ?? 0) || null;
      if (rch  != null) bits.push(`👥 ${int(rch)} reach`);
      if (impr != null) bits.push(`👁 ${int(impr)} impressions`);
      if (eng  != null) bits.push(`❤️ ${int(eng)} engagement`);
      if (fol  != null) bits.push(`👍 ${int(fol)} follows`);
      bits.push(`💰 ${money(tot, cur)}`);
      if (impr) bits.push(`CPM ${money(ratio(tot, impr / 1000), cur)}`);
      if (eng)  bits.push(`CPE ${money(ratio(tot, eng), cur)}`);
      // TikTok is labelled rather than added in: it is not a connected
      // platform and its spend is not in the Meta total above, so folding the
      // two together would make a cost per result that means nothing.
      const tImpr = n(r.tiktok_impressions);
      const tView = n(r.tiktok_video_views);
      if (tImpr != null || tView != null) {
        const tt: string[] = [];
        if (tImpr != null) tt.push(`${int(tImpr)} impressions`);
        if (tView != null) tt.push(`${int(tView)} views`);
        bits.push(`🎵 TikTok ${tt.join(" · ")}`);
      }
      break;
    }
    case "messages": {
      const orders = n(r.msg_orders);
      bits.push(`💬 ${int(msgs)}`);
      bits.push(`📦 ${int(orders)} orders`);
      bits.push(`💰 ${money(conv, cur)}`);
      bits.push(`CPO ${money(ratio(conv, orders), cur)}`);
      bits.push(`ROAS ${roas(conv)}`);
      break;
    }
    default: {
      // full, google-ads and anything unset
      const orders = (n(r.web_orders_confirmed) ?? n(r.web_orders) ?? 0) + (n(r.msg_orders) ?? 0) || null;
      bits.push(`📦 ${int(orders)} orders`);
      bits.push(`💵 ${money(rev, cur)}`);
      bits.push(`💰 ${money(conv, cur)}`);
      bits.push(`ROAS ${roas(conv)}`);
      break;
    }
  }
  return `<b>${esc(name)}</b>\n  ${bits.join(" · ")}`;
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

  const { data: rows } = await admin
    .from("notion_daily")
    .select("*")
    .eq("day", day);

  const byAccount: Record<string, Row> = {};
  for (const r of rows ?? []) byAccount[String((r as Row).account_key)] = r as Row;

  const { data: groups } = await admin
    .from("account_groups")
    .select("id, name, account_ids, dashboard_template, notion_url")
    .not("notion_url", "is", null)
    .order("name");

  // One line per client, not per ad account.
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
    const r = (groupKey ? byAccount[groupKey] : undefined) ?? byAccount[String(accts[0].id)];

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
    withData.push({ name, line: lineFor(tmpl, label, cur, r) });
  }

  // A group whose sheet no account carries -- nothing should fall through
  // silently just because the link lives only on the group.
  for (const [url, g] of groupByUrl) {
    if (byUrl.has(url)) continue;
    const r = byAccount["__group__" + String(g.id)];
    const name = String(g.name ?? "Client");
    if (!r) { noData.push(name); continue; }
    withData.push({ name, line: lineFor(String(g.dashboard_template ?? "full"), name, "", r) });
  }

  withData.sort((a, b) => a.name.localeCompare(b.name));
  noData.sort((a, b) => a.localeCompare(b));

  const human = new Date(day + "T12:00:00Z")
    .toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

  let text = `📊 <b>Blue Ad — ${esc(human)}</b>\n\n`;
  text += withData.length
    ? withData.map(w => w.line).join("\n\n")
    : "No client has figures for this day yet.";
  if (noData.length) {
    text += `\n\n<i>Sheet not filled for this day (${noData.length}):</i>\n` +
            esc(noData.join(", "));
  }

  // Telegram refuses a message over 4096 characters, and silently losing the
  // tail would be worse than sending two.
  //
  // Splitting on a fixed offset was wrong: at 3800 characters the cut lands
  // wherever it lands, including the middle of a <b> tag, and Telegram rejects
  // the whole message when the HTML does not parse. It has not happened yet
  // only because the report still fits in one. The split is between accounts
  // now, which is both safe and where a reader would expect it.
  const chunks: string[] = [];
  {
    const LIMIT = 3500;
    let cur = "";
    for (const block of text.split("\n\n")) {
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
