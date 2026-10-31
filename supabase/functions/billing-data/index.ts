/**
 * billing-data — Supabase Edge Function
 *
 * Answers one question: what do we invoice, and for how much.
 *
 * The contracts live in Notion (Client Contracts, inside 💰 Billing &
 * Invoicing) because that is where the team maintains them. Notion can only
 * be read with the integration key, which is server-side, so the Billing pane
 * cannot read them directly — hence this function.
 *
 * The fee comes from the contract's billing model:
 *
 *   Fixed                  → Minimum Fees
 *   % of Spend             → spend × Percentage
 *   Fixed + %              → Minimum Fees + (spend × Percentage)
 *   Higher of Fixed or %   → max(Minimum Fees, spend × Percentage)
 *
 * "Higher of" is the normal case at Blue Ad: the minimum is a floor the
 * client pays whatever happens, and the percentage takes over once the ad
 * spend is big enough. Dafa at 6,500 / 20% is the shape of it — October spend
 * of 34,664 put the percentage (6,933) above the floor, so the floor did not
 * apply.
 *
 * The spend period is the 30 days ending the day before the next billing
 * date — "we calculate from 30 days before", not the calendar month. A client
 * billed on the 29th is charged for the 29th-to-28th window, which is why
 * reading their invoice against a calendar month never reconciles.
 *
 * Spend is read from notion_daily, the same table the charts use, so the
 * figure here and the figure on the account dashboard are the same number.
 *
 * Nothing is written anywhere. No invoice is raised, no Notion value is
 * changed. This reports what the contract implies; raising it stays manual.
 *
 * Environment:
 *   NOTION_API_KEY — the Blue Ad integration, already used by notion-sync
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

const NOTION = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
/** Client Contracts. One row per client per service. */
const CONTRACTS_DB = "05cf25fe-d1e0-4fcc-935a-d77f19bfd912";

// ── Notion ────────────────────────────────────────────────────────────────

type Contract = {
  page_id: string;
  client: string;
  service: string;
  status: string;
  trigger: string;
  model: string;
  minimum: number | null;
  percentage: number | null;   // 0.2 for 20%
  billing_day: number | null;
  spend_period: string;
  currency: string;
  zoho_customer_id: string;
  zoho_org: string;
  notes: string;
};

// deno-lint-ignore no-explicit-any
function plain(prop: any): string {
  const arr = prop?.title ?? prop?.rich_text ?? [];
  return (arr as { plain_text?: string }[]).map(t => t.plain_text ?? "").join("").trim();
}

async function readContracts(token: string): Promise<Contract[]> {
  const out: Contract[] = [];
  let cursor: string | undefined;
  do {
    const r = await fetch(`${NOTION}/databases/${CONTRACTS_DB}/query`, {
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
      const q = p.properties ?? {};
      out.push({
        page_id: String(p.id),
        client: plain(q["Client"]) || "(untitled)",
        service: q["Service"]?.select?.name ?? "",
        status: q["Status"]?.select?.name ?? "",
        // A row with no trigger set is read from its billing day: a date
        // means it recurs, no date means somebody invoices it when the work
        // is handed over. Guessing beats dropping the row.
        trigger: q["Billing Trigger"]?.select?.name
              ?? (q["Billing Day"]?.number ? "Monthly" : "On delivery"),
        model: q["Billing Model"]?.select?.name ?? "",
        minimum: q["Minimum Fees"]?.number ?? null,
        percentage: q["Percentage"]?.number ?? null,
        billing_day: q["Billing Day"]?.number ?? null,
        spend_period: q["Spend Period"]?.select?.name ?? "",
        currency: q["Currency"]?.select?.name ?? "EGP",
        zoho_customer_id: plain(q["Zoho Customer ID"]),
        zoho_org: q["Zoho Org"]?.select?.name ?? "",
        notes: plain(q["Notes"]),
      });
    }
    cursor = b.has_more ? b.next_cursor : undefined;
  } while (cursor);
  return out;
}

// ── Dates ─────────────────────────────────────────────────────────────────

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Cairo's date, so "today" means today here and not in UTC. */
function cairoToday(): string {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** A billing day of 31 means the last day of whatever month it lands in. */
function billingDateIn(y: number, m: number, day: number): Date {
  return new Date(Date.UTC(y, m, Math.min(day, daysInMonth(y, m))));
}

/**
 * The window the next invoice covers: the 30 days ending the day before the
 * next billing date. On the billing day itself the window has just closed, so
 * that day's invoice is the one reported — not next month's.
 */
function windowFor(today: string, day: number) {
  const t = new Date(`${today}T00:00:00Z`);
  const y = t.getUTCFullYear(), m = t.getUTCMonth();
  let next = billingDateIn(y, m, day);
  if (next.getTime() < t.getTime()) next = billingDateIn(y, m + 1, day);

  const end = new Date(next.getTime() - 86400_000);
  const start = new Date(end.getTime() - 29 * 86400_000);
  const prev = billingDateIn(next.getUTCFullYear(), next.getUTCMonth() - 1, day);
  return {
    billing_date: iso(next),
    period_start: iso(start),
    period_end: iso(end),
    last_billing: iso(prev),
    days_until: Math.round((next.getTime() - t.getTime()) / 86400_000),
  };
}

// ── Matching a contract to the account it spends through ──────────────────
//
// The contracts carry no account id yet, so the link is made on the name.
// It is deliberately reported back: a contract matched to the wrong account
// would produce a confident, wrong invoice, and the only way anybody notices
// is by seeing which account the figure came from.

const norm = (s: string) =>
  String(s ?? "").toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(the|and|agency|store|shop|abaya|group|ltd|co|eg|egp)\b/g, " ")
    .replace(/[^a-z0-9]/g, "");

type Candidate = { key: string; name: string; kind: "group" | "account" };

function bestMatch(client: string, cands: Candidate[]): Candidate | null {
  const c = norm(client);
  if (!c) return null;
  let best: Candidate | null = null, bestLen = Infinity;
  for (const cand of cands) {
    const n = norm(cand.name);
    if (!n) continue;
    const hit = n === c || n.startsWith(c) || c.startsWith(n) || n.includes(c) || c.includes(n);
    if (!hit) continue;
    // A group wins over its own member accounts: the member rows are copies
    // of the same shared sheet, so counting one of them is counting all.
    const score = (cand.kind === "group" ? 0 : 1000) + Math.abs(n.length - c.length);
    if (score < bestLen) { best = cand; bestLen = score; }
  }
  return best;
}

// ── The fee ───────────────────────────────────────────────────────────────

function feeFor(model: string, minimum: number | null, pct: number | null, spend: number | null) {
  const min = minimum ?? 0;
  const fromPct = (pct != null && spend != null) ? spend * pct : null;
  switch (model) {
    case "Fixed":
      return { fee: min, basis: "minimum" as const };
    case "% of Spend":
      return fromPct == null
        ? { fee: null, basis: "no-spend" as const }
        : { fee: fromPct, basis: "percentage" as const };
    case "Fixed + %":
      return fromPct == null
        ? { fee: null, basis: "no-spend" as const }
        : { fee: min + fromPct, basis: "both" as const };
    case "Higher of Fixed or %":
      if (fromPct == null) {
        // No spend figure yet. The floor is still owed, so it is the answer
        // — but say so, because the percentage may well exceed it.
        return { fee: min, basis: "minimum-provisional" as const };
      }
      return fromPct >= min
        ? { fee: fromPct, basis: "percentage" as const }
        : { fee: min, basis: "minimum" as const };
    default:
      return { fee: min || null, basis: "no-model" as const };
  }
}

// ── Handler ───────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const auth = req.headers.get("Authorization");
  if (!auth) return json({ error: "Unauthorized" }, 401);
  const { data: { user }, error: authErr } =
    await admin.auth.getUser(auth.replace("Bearer ", ""));
  if (authErr || !user) return json({ error: "Unauthorized" }, 401);

  let body: { orgId?: string; day?: string } = {};
  try { body = await req.json(); } catch { /* no body */ }

  const token = Deno.env.get("NOTION_API_KEY");
  if (!token) return json({ error: "NO_NOTION_KEY" }, 422);

  const today = body.day || cairoToday();

  let contracts: Contract[];
  try {
    contracts = await readContracts(token);
  } catch (e) {
    return json({ error: "NOTION_READ_FAILED", detail: (e as Error).message }, 502);
  }

  const live = contracts.filter(c => c.status === "Active");

  // Accounts and groups this org can bill against.
  const [{ data: accts }, { data: groups }] = await Promise.all([
    admin.from("meta_ad_accounts").select("id, account_name, organization_id")
      .eq("organization_id", body.orgId ?? "").eq("is_active", true),
    admin.from("account_groups").select("id, name, organization_id")
      .eq("organization_id", body.orgId ?? ""),
  ]);
  const cands: Candidate[] = [
    ...(groups ?? []).map(g => ({ key: `__group__${g.id}`, name: g.name, kind: "group" as const })),
    ...(accts ?? []).map(a => ({ key: String(a.id), name: a.account_name, kind: "account" as const })),
  ];

  // One spend query for the whole pane rather than one per contract.
  // Project work — content shoots, AI reels, SEO articles — is invoiced when
  // it is delivered, not on a day of the month. It has no window and no
  // spend, so it is matched to nothing and costs no query.
  const isMonthly = (c: Contract) => c.trigger === "Monthly" && !!c.billing_day;

  const matched = live.map(c => ({ c, m: isMonthly(c) ? bestMatch(c.client, cands) : null }));
  const keys = [...new Set(matched.map(x => x.m?.key).filter(Boolean))] as string[];
  const earliest = matched
    .map(x => isMonthly(x.c) ? windowFor(today, x.c.billing_day!).period_start : null)
    .filter(Boolean).sort()[0] as string | undefined;

  type Row = { account_key: string; day: string; sp: number };
  let rows: Row[] = [];
  if (keys.length && earliest) {
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin
        .from("notion_daily")
        .select("account_key, day, total_spend, web_spend, msg_spend, branding_spend, engagement_spend, follow_spend, profile_visit_spend, courses_spend, tahfez_spend, tiktok_spend")
        .in("account_key", keys)
        .gte("day", earliest)
        .lte("day", today)
        .order("day", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) return json({ error: "SPEND_READ_FAILED", detail: error.message }, 502);
      for (const r of data ?? []) {
        // Some sheets fill total_spend, others only the per-objective
        // columns. Taking the total when it is there and the sum of the
        // parts when it is not avoids both double-counting and zeroes.
        const total = Number(r.total_spend ?? 0);
        const parts = ["web_spend", "msg_spend", "branding_spend", "engagement_spend",
                       "follow_spend", "profile_visit_spend", "courses_spend",
                       "tahfez_spend", "tiktok_spend"]
          // deno-lint-ignore no-explicit-any
          .reduce((t, k) => t + Number((r as any)[k] ?? 0), 0);
        rows.push({ account_key: String(r.account_key), day: String(r.day).slice(0, 10), sp: total > 0 ? total : parts });
      }
      if (!data || data.length < PAGE) break;
      if (rows.length >= 40000) break;
    }
  }

  const spendIn = (key: string | undefined, from: string, to: string) => {
    if (!key) return null;
    let any = false, sum = 0;
    for (const r of rows) {
      if (r.account_key !== key || r.day < from || r.day > to) continue;
      any = true; sum += r.sp;
    }
    return any ? sum : null;
  };

  const out = matched.map(({ c, m }) => {
    const monthly = isMonthly(c);
    const w = monthly ? windowFor(today, c.billing_day!) : null;
    const spend = w ? spendIn(m?.key, w.period_start, w.period_end) : null;
    const { fee, basis } = monthly
      ? feeFor(c.model, c.minimum, c.percentage, spend)
      // Delivered work is worth what was quoted. There is no spend to take a
      // percentage of, and no date to put against it until it is handed over.
      : { fee: c.minimum, basis: "on-delivery" as const };
    return {
      page_id: c.page_id,
      client: c.client,
      service: c.service,
      trigger: c.trigger,
      currency: c.currency,
      zoho_customer_id: c.zoho_customer_id,
      zoho_org: c.zoho_org,
      model: c.model,
      minimum: c.minimum,
      percentage: c.percentage,
      billing_day: c.billing_day,
      spend_period: c.spend_period,
      notes: c.notes,
      matched_account: m?.name ?? null,
      matched_kind: m?.kind ?? null,
      spend,
      fee,
      basis,
      ...(w ?? { billing_date: null, period_start: null, period_end: null, last_billing: null, days_until: null }),
    };
  }).sort((a, b) => (a.days_until ?? 999) - (b.days_until ?? 999));

  return json({
    ok: true,
    today,
    contracts: out,
    skipped: contracts.filter(c => c.status !== "Active").length,
    // Said plainly rather than left for the reader to notice. Only monthly
    // contracts are judged: project work is meant to have no billing day.
    needs_attention: out.filter(r =>
      r.trigger === "Monthly" &&
      (!r.billing_day || !r.model || (r.percentage != null && !r.matched_account))
    ).map(r => r.client),
  });
});
