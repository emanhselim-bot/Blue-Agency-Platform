/**
 * expenses-due-watch — Supabase Edge Function
 *
 * Asks, on the day, whether a recurring expense was actually paid.
 *
 * The DWE fixed-expense sheet in Notion is a list of subscriptions with a
 * date and a status. Claude at 7,000, Notion at 82.99 and IG Verification at
 * 250 all sit at "Not started" on their renewal date, and nothing says so
 * until somebody opens the page. They then either get paid and forgotten, or
 * recorded weeks late against the wrong month.
 *
 * This reads the sheet each morning and messages the ones due today or
 * already past their date and still unpaid. It asks rather than assumes:
 * Notion is the source of truth, so the answer is given by flipping the row
 * to Done there, and the transfer to Zoho follows from that. Nothing is
 * written to Zoho from here, and no reply to the message is needed.
 *
 * Deliberately not automatic: posting an expense because its renewal date
 * passed would be recording a payment nobody confirmed, and an unpaid
 * subscription is exactly the case where that is wrong.
 *
 * Environment:
 *   NOTION_API_KEY       — the Blue Ad integration, already used by notion-sync
 *   TELEGRAM_BOT_TOKEN   — same bot as the other watches
 *   TELEGRAM_CHAT_ID
 *   app_secrets.notion_cron — the shared secret the cron sends
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const NOTION = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// The DWE fixed-expense sheet. One per month; this is the live one.
const FIXED_DB = "48e2fae6-c859-8292-9857-87a1d6e57c0d";

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

/** Cairo's date and hour, so "today" means today here and not in UTC. */
function cairoNow() {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

const esc = (s: string) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const money = (n: number) =>
  Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });

type Row = {
  id: string;
  name: string;
  amount: number | null;
  due: string | null;
  status: string;
  zohoId: string;
};

/** Plain text out of a Notion rich-text or title array. */
// deno-lint-ignore no-explicit-any
function plain(prop: any): string {
  const arr = prop?.title ?? prop?.rich_text ?? [];
  return (arr as { plain_text?: string }[]).map(t => t.plain_text ?? "").join("").trim();
}

async function readSheet(token: string): Promise<Row[]> {
  const out: Row[] = [];
  let cursor: string | undefined;
  do {
    const r = await fetch(`${NOTION}/databases/${FIXED_DB}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: 100, start_cursor: cursor }),
      signal: AbortSignal.timeout(20_000),
    });
    const b = await r.json();
    if (!r.ok) throw new Error(b?.message ?? `Notion ${r.status}`);
    for (const p of b.results ?? []) {
      const props = p.properties ?? {};
      out.push({
        id: String(p.id),
        // The title property is "Name " — with the trailing space the sheet
        // was created with. Matching on the type rather than the name keeps
        // this working if somebody tidies that up.
        name: plain(Object.values(props).find((x: unknown) =>
          (x as { type?: string })?.type === "title")) || "(untitled)",
        amount: props["Amount"]?.number ?? null,
        due: props["Date"]?.date?.start ?? null,
        status: props["Status"]?.status?.name ?? "",
        zohoId: plain(props["Zoho Expense ID"]),
      });
    }
    cursor = b.has_more ? b.next_cursor : undefined;
  } while (cursor);
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  let body: { cron_secret?: string; dry_run?: boolean; force?: boolean; day?: string };
  try { body = await req.json(); } catch { body = {}; }

  const { data: secretRow } = await admin
    .from("app_secrets").select("value").eq("key", "notion_cron").maybeSingle();
  const secret = String(secretRow?.value ?? "");
  if (!secret || secret !== body.cron_secret) return json({ error: "Unauthorized" }, 401);

  const tgToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  const notionToken = Deno.env.get("NOTION_API_KEY");
  if (!notionToken) return json({ error: "NO_NOTION_KEY" }, 422);
  if ((!tgToken || !chatId) && !body.dry_run) return json({ error: "NO_TELEGRAM_CONFIG" }, 422);

  // The cron fires at both hours 9am Cairo could be in UTC across the year.
  const now = cairoNow();
  if (!body.force && !body.dry_run && now.hour !== 9) {
    return json({ ok: true, skipped: true, reason: `Cairo hour is ${now.hour}` });
  }
  const today = body.day || now.date;

  let rows: Row[];
  try {
    rows = await readSheet(notionToken);
  } catch (e) {
    return json({ error: "NOTION_READ_FAILED", detail: (e as Error).message }, 502);
  }

  // Due today or overdue, not yet marked paid, and not already in Zoho.
  const waiting = rows.filter(r =>
    r.status !== "Done" && !r.zohoId && r.due && r.due <= today);

  // A row with no amount cannot be posted even once it is paid, so it is
  // worth naming separately rather than leaving it to be noticed in December.
  const noAmount = rows.filter(r => r.status !== "Done" && !r.zohoId && r.amount == null);

  if (!waiting.length && !noAmount.length) {
    return json({ ok: true, today, waiting: 0, sent: false });
  }

  const lines: string[] = [`<b>💳 Recurring expenses — ${esc(today)}</b>`];

  if (waiting.length) {
    const total = waiting.reduce((t, r) => t + (r.amount ?? 0), 0);
    lines.push("", `<b>Due and still unpaid</b> — ${money(total)} EGP`);
    for (const r of waiting) {
      const late = r.due && r.due < today;
      lines.push(
        `• ${esc(r.name)} — <b>${r.amount == null ? "no amount" : money(r.amount) + " EGP"}</b>` +
        (late ? ` · <i>was due ${esc(r.due!)}</i>` : " · due today"),
      );
    }
    lines.push("", "Paid? Mark it <b>Done</b> in Notion and it goes to Zoho on the next run.");
  }

  if (noAmount.length) {
    lines.push("", "<b>No amount filled in</b> — cannot be posted even once paid");
    for (const r of noAmount) lines.push(`• ${esc(r.name)}`);
  }

  const text = lines.join("\n");
  if (body.dry_run) return json({ ok: true, today, waiting: waiting.length, dry_run: true, text });

  const r = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const rb = await r.json();
  if (!rb.ok) return json({ error: "TELEGRAM_SEND_FAILED", detail: rb.description }, 502);

  return json({ ok: true, today, waiting: waiting.length, no_amount: noAmount.length, sent: true });
});
