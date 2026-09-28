/**
 * Notion "Daily Reports" -> monthly_history
 *
 * The media buying team records each client's day in Notion: messages, orders,
 * pieces, revenue and the spend split between website and message campaigns.
 * Nobody then retypes it into the dashboard, so months that are fully recorded
 * in Notion read as empty here. Maree's August is the case that proved it --
 * Notion held 85 web orders, 170 pieces and EGP 150,833 that the dashboard did
 * not, while the spend figures agreed to within 7 EGP.
 *
 * Shape of the source: one Notion database per client per month, one row per
 * day, sitting under
 *   Media Buying Performance Reports / <buyer> / <client> / <year> / Daily Reports
 *
 * Three things about that shape drive the design:
 *
 *  1. Column names differ per client. Maree has "Website Spending" and
 *     "No,Purchase"; Basma has " Spending Web", "Spending SM" and "No.purchase",
 *     plus FB / IG / WhatsApp splits. So columns are matched on a normalised
 *     name (lowercased, punctuation and spaces removed) against a synonym list,
 *     never on an exact string.
 *
 *  2. Database titles are unreliable -- "September" and "September " both exist,
 *     and a month's database can be renamed. So the month a figure belongs to is
 *     read from each row's own Date property, never from the database title. A
 *     mislabelled database therefore cannot file August under September.
 *
 *  3. Client names do not match account names ("Basma" is "Basma natural EGP";
 *     "Ibriz" matches two accounts). So nothing is matched by name: a person
 *     pastes the Notion link on the account, and that link is the only mapping.
 *
 * Writes fill blanks only. A figure already in monthly_history -- typed by hand,
 * confirmed from Shopify, or filled from Meta -- is never overwritten, so a
 * sync cannot quietly replace someone's correction. Fields Notion did not
 * supply are left alone rather than zeroed.
 *
 * Revenue is deliberately narrow. Notion records one Revenue number per day
 * covering every channel on that row, while the dashboard splits revenue into
 * website and message revenue. There is no honest way to divide one into the
 * other, so Revenue is written to total_revenue, which means exactly "the
 * month's revenue as recorded", and web_revenue / msg_revenue are left empty.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const NOTION = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// Enough to walk client -> year -> Daily Reports -> month database, with room
// for a stray wrapper page, without letting a mis-paste crawl a whole workspace.
const MAX_DEPTH = 5;
const MAX_NODES = 300;
const MAX_DB_PAGES = 20;          // 100 rows a page; a month is one page

// Earliest month a sync will touch. Sheets older than this use yet more column
// spellings and are not worth trusting.
const FLOOR_MONTH = "2025-01";

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

// ── Column matching ───────────────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Normalised Notion column name -> what it means. Several spellings per meaning
// because each media buyer built their own sheet.
const FIELD_SYNONYMS: Record<string, string[]> = {
  web_orders: ["weborders", "weborder", "websiteorders", "websiteorder"],
  web_pieces: ["webpieces", "webpiece", "websitepieces"],
  web_spend:  ["websitespending", "spendingweb", "webspending", "spendweb", "websitespend"],
  msg_spend:  ["spendingsm", "smspending", "messagespending", "spendingmsg", "msgspending"],
  msg_count:  ["totalnomsgs", "totalmsgs", "totalnomsg", "nomsgs", "messages", "totalmessages"],
  revenue:    ["revenue", "totalrevenue", "sales"],
  // Message-channel orders. "No.purchase" is the total the team records; the
  // FB / IG / WhatsApp columns are a breakdown that does not always add up to
  // it (Basma's September: 66 + 39 + 37 = 142 against 147), so the total is
  // trusted when present and the breakdown only used in its absence.
  msg_orders_total: ["nopurchase", "nopurchases", "purchases", "noofpurchase"],
  msg_orders_parts: ["fborder", "fborders", "igorder", "igorders", "whatsorder", "whatsorders",
                     "whatsapporder", "whatsapporders"],
  msg_pieces_parts: ["fbpieces", "fbpiece", "igpieces", "igpiece", "whatspieces", "whatspiece",
                     "whatsapppieces"],
};

// Reverse index, built once.
const MEANING_OF: Record<string, string> = {};
for (const [meaning, names] of Object.entries(FIELD_SYNONYMS)) {
  for (const n of names) MEANING_OF[n] = meaning;
}

// ── Notion plumbing ───────────────────────────────────────────────────────────

function idFromUrl(raw: string): string | null {
  // A Notion database link carries two 32-hex ids: the database in the path and
  // the view in ?v=. Only the path is looked at, so the view id cannot win.
  let path = raw.trim();
  try { path = new URL(path.startsWith("http") ? path : "https://" + path).pathname; } catch { /* treat as bare id */ }
  const hits = path.match(/[0-9a-f]{32}/gi);
  if (hits?.length) return hits[hits.length - 1].toLowerCase();
  const dashed = path.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return dashed ? dashed[0].replace(/-/g, "").toLowerCase() : null;
}

async function notion(token: string, path: string, init?: RequestInit) {
  const res = await fetch(NOTION + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) throw new Error("BAD_NOTION_TOKEN");
  if (res.status === 429) throw new Error("RATE_LIMITED");
  if (res.status === 404) throw new Error("NOT_SHARED");
  if (!res.ok) throw new Error(`Notion returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return await res.json();
}

/**
 * Collect every database in the subtree under `rootId`.
 *
 * The pasted link may point at the client page, a year page, the "Daily
 * Reports" page or a single month's database -- people paste whatever tab they
 * had open. Rather than require one of those, this walks down from wherever it
 * starts and gathers the databases it finds, so all four pastes work.
 */
async function findDatabases(token: string, rootId: string) {
  const found: { id: string; title: string }[] = [];
  const seen = new Set<string>();
  let queue: { id: string; depth: number }[] = [{ id: rootId, depth: 0 }];
  let visited = 0;

  // The root itself may already be a database.
  try {
    const db = await notion(token, `/databases/${rootId}`);
    found.push({ id: rootId, title: plainTitle(db?.title) });
    seen.add(rootId);
    return found;
  } catch (e) {
    // Not a database (or not shared) -- fall through and treat it as a page.
    if ((e as Error).message === "BAD_NOTION_TOKEN") throw e;
  }

  while (queue.length && visited < MAX_NODES) {
    const next: { id: string; depth: number }[] = [];
    for (const node of queue) {
      if (visited >= MAX_NODES) break;
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      visited++;

      let cursor: string | undefined;
      do {
        const q = new URLSearchParams({ page_size: "100" });
        if (cursor) q.set("start_cursor", cursor);
        let page: { results?: Record<string, unknown>[]; next_cursor?: string; has_more?: boolean };
        try {
          page = await notion(token, `/blocks/${node.id}/children?${q}`);
        } catch (e) {
          if ((e as Error).message === "BAD_NOTION_TOKEN") throw e;
          break;   // an unshared or deleted child should not abort the whole walk
        }
        for (const b of page.results ?? []) {
          const type = b.type as string;
          if (type === "child_database") {
            const id = String(b.id).replace(/-/g, "");
            if (!seen.has(id)) {
              seen.add(id);
              found.push({ id, title: String((b.child_database as { title?: string })?.title ?? "") });
            }
          } else if (type === "child_page" && node.depth < MAX_DEPTH) {
            next.push({ id: String(b.id).replace(/-/g, ""), depth: node.depth + 1 });
          }
        }
        cursor = page.has_more ? page.next_cursor : undefined;
      } while (cursor);
    }
    queue = next;
  }
  return found;
}

function plainTitle(t: unknown): string {
  if (!Array.isArray(t)) return "";
  return t.map(x => (x as { plain_text?: string })?.plain_text ?? "").join("").trim();
}

/** Pull a number out of whatever property type the team used. */
function numberOf(prop: Record<string, unknown> | undefined): number | null {
  if (!prop) return null;
  const t = prop.type as string;
  if (t === "number")  return typeof prop.number === "number" ? prop.number : null;
  if (t === "formula") {
    const f = prop.formula as { type?: string; number?: number };
    return f?.type === "number" && typeof f.number === "number" ? f.number : null;
  }
  if (t === "rollup") {
    const r = prop.rollup as { type?: string; number?: number };
    return r?.type === "number" && typeof r.number === "number" ? r.number : null;
  }
  // A figure typed into a text column still counts -- but only if it parses
  // cleanly, so "n/a" or "check with client" does not become 0.
  if (t === "rich_text" || t === "title") {
    const s = plainTitle(prop[t]).replace(/[, ]/g, "");
    if (!s) return null;
    const n = Number(s);
    return isFinite(n) ? n : null;
  }
  return null;
}

function dateOf(props: Record<string, Record<string, unknown>>): string | null {
  for (const p of Object.values(props)) {
    if (p?.type === "date") {
      const d = (p.date as { start?: string })?.start;
      if (d) return d.slice(0, 10);
    }
  }
  return null;
}

// ── Aggregation ───────────────────────────────────────────────────────────────

type MonthSums = {
  web_orders: number | null; web_pieces: number | null;
  web_spend: number | null;  msg_spend: number | null;
  msg_orders: number | null; msg_pieces: number | null;
  msg_count: number | null;  total_revenue: number | null;
  days: number;
};

const blank = (): MonthSums => ({
  web_orders: null, web_pieces: null, web_spend: null, msg_spend: null,
  msg_orders: null, msg_pieces: null, msg_count: null, total_revenue: null, days: 0,
});

// null + value = value, so a month keeps null for a column the sheet never had
// rather than reporting a confident 0.
const add = (a: number | null, b: number | null) => b == null ? a : (a ?? 0) + b;

async function sumDatabases(token: string, dbs: { id: string; title: string }[], untilMonth: string) {
  const months: Record<string, MonthSums> = {};
  const columnsSeen = new Set<string>();
  const columnsIgnored = new Set<string>();
  let rows = 0, undated = 0;

  for (const db of dbs) {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_DB_PAGES; page++) {
      const body: Record<string, unknown> = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const res = await notion(token, `/databases/${db.id}/query`, {
        method: "POST", body: JSON.stringify(body),
      });

      for (const row of res.results ?? []) {
        const props = (row.properties ?? {}) as Record<string, Record<string, unknown>>;
        const day = dateOf(props);
        if (!day) { undated++; continue; }
        const month = day.slice(0, 7);
        if (month < FLOOR_MONTH || month > untilMonth) continue;
        rows++;

        const m = (months[month] ||= blank());
        m.days++;

        let msgOrdersTotal: number | null = null;
        let msgOrdersParts: number | null = null;

        for (const [name, prop] of Object.entries(props)) {
          const meaning = MEANING_OF[norm(name)];
          if (!meaning) {
            // Only worth reporting if it actually held a number.
            if (numberOf(prop) != null) columnsIgnored.add(name.trim());
            continue;
          }
          const v = numberOf(prop);
          if (v == null) continue;
          columnsSeen.add(name.trim());

          switch (meaning) {
            case "web_orders": m.web_orders = add(m.web_orders, v); break;
            case "web_pieces": m.web_pieces = add(m.web_pieces, v); break;
            case "web_spend":  m.web_spend  = add(m.web_spend,  v); break;
            case "msg_spend":  m.msg_spend  = add(m.msg_spend,  v); break;
            case "msg_count":  m.msg_count  = add(m.msg_count,  v); break;
            case "revenue":    m.total_revenue = add(m.total_revenue, v); break;
            case "msg_orders_total": msgOrdersTotal = add(msgOrdersTotal, v); break;
            case "msg_orders_parts": msgOrdersParts = add(msgOrdersParts, v); break;
            case "msg_pieces_parts": m.msg_pieces = add(m.msg_pieces, v); break;
          }
        }

        // Per row, not per month: the total wins where the team recorded one.
        const msgOrders = msgOrdersTotal ?? msgOrdersParts;
        if (msgOrders != null) m.msg_orders = add(m.msg_orders, msgOrders);
      }

      if (!res.has_more) break;
      cursor = res.next_cursor;
    }
  }

  return { months, rows, undated,
           columns: [...columnsSeen].sort(), ignored: [...columnsIgnored].sort() };
}

// ── Writing ───────────────────────────────────────────────────────────────────

const WRITE_FIELDS = [
  "web_orders", "web_pieces", "web_spend", "msg_spend",
  "msg_orders", "msg_pieces", "msg_count", "total_revenue",
] as const;

/**
 * Fill blanks only.
 *
 * A month already holding a figure keeps it, whether it was typed by a media
 * buyer, confirmed from Shopify or filled from Meta. Only columns that are null
 * in monthly_history are written, and only where Notion actually has a number.
 */
async function applyMonths(
  orgId: string, accountKey: string, agencyId: string | null, currency: string | null,
  months: Record<string, MonthSums>,
) {
  const keys = Object.keys(months).sort();
  if (!keys.length) return { filled: 0, kept: 0, monthsTouched: [] as string[], detail: [] as unknown[] };

  const { data: existing, error: readErr } = await admin
    .from("monthly_history")
    .select(`id, month, ${WRITE_FIELDS.join(", ")}`)
    .eq("organization_id", orgId)
    .eq("account_key", accountKey)
    .in("month", keys.map(k => `${k}-01`));
  if (readErr) throw new Error(readErr.message);

  const byMonth: Record<string, Record<string, unknown>> = {};
  for (const r of existing ?? []) byMonth[String((r as { month: string }).month).slice(0, 7)] = r;

  let filled = 0, kept = 0;
  const monthsTouched: string[] = [];
  const detail: unknown[] = [];

  for (const key of keys) {
    const src = months[key];
    const row = byMonth[key];
    const patch: Record<string, unknown> = {};
    const keptHere: string[] = [];

    for (const f of WRITE_FIELDS) {
      const v = src[f];
      if (v == null) continue;
      const current = row ? row[f] : null;
      if (current == null || current === "") { patch[f] = v; filled++; }
      else { kept++; keptHere.push(f); }
    }

    if (!Object.keys(patch).length) {
      if (keptHere.length) detail.push({ month: key, filled: [], kept: keptHere });
      continue;
    }

    if (row) {
      const { error } = await admin.from("monthly_history")
        .update(patch).eq("id", (row as { id: string }).id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await admin.from("monthly_history").insert({
        organization_id: orgId,
        account_key: accountKey,
        agency_id: agencyId,
        month: `${key}-01`,
        currency,
        ...patch,
      });
      if (error) throw new Error(error.message);
    }
    monthsTouched.push(key);
    detail.push({ month: key, days: src.days, filled: Object.keys(patch), kept: keptHere });
  }

  return { filled, kept, monthsTouched, detail };
}

// ── Handler ───────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const token = Deno.env.get("NOTION_API_KEY");
  if (!token) {
    return json({
      error: "NO_NOTION_TOKEN",
      hint: "Create an internal integration in Notion, share the Media Buying Performance Reports page with it, " +
            "and set its secret as NOTION_API_KEY in Supabase.",
    }, 422);
  }

  let body: {
    account_id?: string;
    url?: string;
    dry_run?: boolean;
    all?: boolean;
    until?: string;
    cron_secret?: string;
  };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  const untilMonth = (body.until || new Date().toISOString().slice(0, 7));

  // Two callers: a signed-in person testing or syncing one account, and the
  // nightly cron doing every linked account. The cron has no user to speak for,
  // so it presents a shared secret instead.
  //
  // That secret is read from the database rather than an environment variable so
  // the cron command and this function draw on one value. app_secrets has RLS on
  // with no policy and no grants to anon or authenticated, so only the service
  // role -- this function -- can read it.
  let isCron = false;
  if (body.cron_secret) {
    const { data: secret } = await admin
      .from("app_secrets").select("value").eq("key", "notion_cron").maybeSingle();
    isCron = !!secret?.value && secret.value === body.cron_secret;
    if (!isCron) return json({ error: "Unauthorized" }, 401);
  }

  let userId: string | null = null;
  if (!isCron) {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const { data: { user }, error } = await admin.auth.getUser(auth.replace("Bearer ", ""));
    if (error || !user) return json({ error: "Unauthorized" }, 401);
    userId = user.id;
  }

  // Which accounts to do.
  type Acct = {
    id: string; organization_id: string; account_name: string | null;
    currency: string | null; agency_id: string | null; notion_url: string | null;
  };
  let accounts: Acct[] = [];

  if (body.account_id) {
    const { data } = await admin.from("meta_ad_accounts")
      .select("id, organization_id, account_name, currency, agency_id, notion_url")
      .eq("id", body.account_id).maybeSingle();
    if (!data) return json({ error: "Account not found" }, 404);
    accounts = [data as Acct];
  } else if (body.all) {
    const { data } = await admin.from("meta_ad_accounts")
      .select("id, organization_id, account_name, currency, agency_id, notion_url")
      .not("notion_url", "is", null);
    accounts = (data ?? []) as Acct[];
  } else {
    return json({ error: "account_id or all is required" }, 400);
  }

  // A person may only touch accounts in an organization they belong to. The cron
  // is not a person and is trusted by its secret.
  if (!isCron) {
    const orgs = new Set(accounts.map(a => a.organization_id));
    for (const org of orgs) {
      const { data: member } = await admin.from("organization_members")
        .select("id").eq("organization_id", org).eq("user_id", userId)
        .not("accepted_at", "is", null).maybeSingle();
      if (!member) return json({ error: "Forbidden" }, 403);
    }
  }

  const results: unknown[] = [];

  for (const acct of accounts) {
    // body.url lets the Test button check a link before it is saved.
    const link = (body.url ?? acct.notion_url ?? "").trim();
    const rootId = link ? idFromUrl(link) : null;

    if (!rootId) {
      results.push({ account: acct.account_name, error: "NO_NOTION_LINK" });
      continue;
    }

    try {
      const dbs = await findDatabases(token, rootId);
      if (!dbs.length) {
        const note = "Nothing found at that link — no databases under it. Check the page is shared with the integration.";
        if (!body.dry_run) {
          await admin.from("meta_ad_accounts")
            .update({ notion_synced_at: new Date().toISOString(), notion_sync_note: note })
            .eq("id", acct.id);
        }
        results.push({ account: acct.account_name, error: "NO_DATABASES", note });
        continue;
      }

      const { months, rows, undated, columns, ignored } =
        await sumDatabases(token, dbs, untilMonth);

      if (body.dry_run) {
        results.push({
          account: acct.account_name,
          databases: dbs.length,
          database_titles: dbs.map(d => d.title || "(untitled)"),
          rows, undated, columns_used: columns, columns_ignored: ignored,
          months: Object.fromEntries(Object.entries(months).sort()),
        });
        continue;
      }

      const applied = await applyMonths(
        acct.organization_id, acct.id, acct.agency_id, acct.currency, months,
      );

      const note =
        `Read ${rows} day${rows === 1 ? "" : "s"} from ${dbs.length} month sheet${dbs.length === 1 ? "" : "s"}. ` +
        `Filled ${applied.filled} blank figure${applied.filled === 1 ? "" : "s"}` +
        (applied.monthsTouched.length ? ` across ${applied.monthsTouched.join(", ")}` : "") +
        `; left ${applied.kept} already-filled figure${applied.kept === 1 ? "" : "s"} untouched.` +
        (ignored.length ? ` Unrecognised columns: ${ignored.slice(0, 6).join(", ")}.` : "");

      await admin.from("meta_ad_accounts")
        .update({ notion_synced_at: new Date().toISOString(), notion_sync_note: note })
        .eq("id", acct.id);

      results.push({
        account: acct.account_name, databases: dbs.length, rows, undated,
        filled: applied.filled, kept: applied.kept,
        months: applied.monthsTouched, detail: applied.detail,
        columns_used: columns, columns_ignored: ignored, note,
      });
    } catch (e) {
      const msg = (e as Error).message || "failed";
      // A bad token is not this account's problem -- stop rather than write the
      // same misleading note onto all 114 of them.
      if (msg === "BAD_NOTION_TOKEN") return json({ error: "BAD_NOTION_TOKEN" }, 401);
      const note =
        msg === "NOT_SHARED"
          ? "Notion says that page does not exist for this integration — share the page with the integration in Notion."
          : msg === "RATE_LIMITED"
          ? "Notion rate-limited the sync; it will catch up on the next run."
          : msg;
      if (!body.dry_run) {
        await admin.from("meta_ad_accounts")
          .update({ notion_synced_at: new Date().toISOString(), notion_sync_note: note })
          .eq("id", acct.id);
      }
      results.push({ account: acct.account_name, error: msg, note });
    }
  }

  return json({ ok: true, until: untilMonth, accounts: results.length, results });
});
