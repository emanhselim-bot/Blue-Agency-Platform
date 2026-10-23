/**
 * ai-chat — Supabase Edge Function
 *
 * Claude with read-only tools over this organization's own figures, so a
 * question like "why did Ibriz's ROAS drop on the 15th" or "which client is
 * losing money this month" can be answered by looking rather than guessing.
 *
 * Required secret: ANTHROPIC_API_KEY
 *
 * ── Why this was rewritten ──────────────────────────────────────────────
 *
 * The previous version took a message and a blob of context from the browser
 * and did no authentication of any kind. verify_jwt is on, but the only key
 * needed to satisfy it is the anon key, which is published in dashboard.html —
 * so anyone who viewed source could call this endpoint and spend the agency's
 * Anthropic credits indefinitely. Confirmed against production before the
 * rewrite: a POST with nothing but the page's own anon key returned 200.
 *
 * It also trusted the caller's figures. Now that the model can read the
 * database, trusting the caller would be far worse: the browser could ask for
 * any account by passing it in. So nothing in the request decides what is
 * readable — the user is identified from their JWT, their membership and their
 * scope come from the database, and every tool result is filtered to the
 * accounts that member is allowed to see.
 *
 * ── Shape ───────────────────────────────────────────────────────────────
 *
 * POST { organization_id, message, history?: [{role, content}], account_hint? }
 * →    { reply, used: string[] }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-5-20250929";
const MAX_TOOL_ROUNDS = 6;      // a loop that cannot end is a bill that cannot end
const MAX_HISTORY = 12;

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

const num = (v: unknown) => (v == null || isNaN(Number(v)) ? null : Number(v));
const round = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);

// The same precedences the dashboard cards and the Telegram report use. A
// figure the assistant quotes has to be the figure on the card, or it is worse
// than no assistant at all.
function convSpend(r: Record<string, unknown>) {
  const parts = [r.web_spend, r.msg_spend, r.courses_spend, r.tahfez_spend].map(num);
  const sum = parts.some(v => v != null) ? parts.reduce<number>((s, v) => s + (v ?? 0), 0) : null;
  const total = num(r.total_spend);
  const lessBrand = total == null ? null : Math.max(0, total - (num(r.branding_spend) ?? 0));
  if (sum == null && lessBrand == null) return null;
  return Math.max(sum ?? 0, lessBrand ?? 0);
}
const totalSpend = (r: Record<string, unknown>) => num(r.total_spend) ?? convSpend(r);
const revenueOf  = (r: Record<string, unknown>) =>
  num(r.web_revenue_confirmed) ?? num(r.total_revenue) ?? num(r.web_revenue);
const webOrders  = (r: Record<string, unknown>) => num(r.web_orders_confirmed) ?? num(r.web_orders) ?? 0;
const msgOrders  = (r: Record<string, unknown>) => num(r.msg_orders) ?? 0;

/**
 * One client, and every notion_daily key that answers for it.
 *
 * `keys` is in priority order: the group key first where there is one, then
 * the ad accounts. A client with two ad accounts has ONE sheet, and the sync
 * files the same figures under every key it answers to — so a day must be
 * read from exactly one of them.
 */
interface Client { name: string; keys: string[] }

/** Who is asking, and which clients they may see. */
interface Scope {
  userId: string;
  email: string;
  orgId: string;
  /** null means every account in the org. */
  accountIds: string[] | null;
  clients: Client[];
  /** Every key across every client in scope, for one-shot queries. */
  keys: string[];
}

/**
 * One row per day, taken from the highest-priority key that has one.
 *
 * Never summed. Retaj and Retaj 2 share a sheet and each carry the same
 * 31,865 of October spend; adding them reports a client that spent twice what
 * it did. This is the same rule the Telegram report uses.
 */
function pickByDay(rows: Record<string, unknown>[], keys: string[]) {
  const rank = new Map(keys.map((k, i) => [k, i]));
  const best = new Map<string, { r: Record<string, unknown>; rank: number }>();
  for (const r of rows) {
    const day = String(r.day).slice(0, 10);
    const kr = rank.get(String(r.account_key));
    if (kr == null) continue;
    const cur = best.get(day);
    if (!cur || kr < cur.rank) best.set(day, { r, rank: kr });
  }
  return [...best.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, v]) => ({ day, row: v.r }));
}

/**
 * Build the scope from the database, never from the request.
 *
 * Mirrors loadMyModules() in the dashboard: owners and admins see everything,
 * everyone else is limited to cp_members.account_ids, and an archived member
 * sees nothing at all.
 */
async function buildScope(userId: string, email: string, orgId: string): Promise<Scope | null> {
  const { data: member } = await admin
    .from("organization_members").select("id")
    .eq("organization_id", orgId).eq("user_id", userId)
    .not("accepted_at", "is", null).maybeSingle();
  if (!member) return null;

  const { data: cp } = await admin
    .from("cp_members").select("role, account_ids, archived")
    .eq("organization_id", orgId).ilike("email", email).maybeSingle();

  if (cp?.archived) return null;
  const privileged = cp?.role === "owner" || cp?.role === "admin";
  // No cp_members row means someone who is on the org but not on the team
  // list. The dashboard treats that as unrestricted; matching it here keeps
  // the two from disagreeing about who can see what.
  const accountIds: string[] | null = privileged || !cp ? null
    : (Array.isArray(cp.account_ids) ? cp.account_ids.map(String) : null);

  const { data: accounts } = await admin
    .from("meta_ad_accounts")
    .select("id, account_name, notion_url")
    .eq("organization_id", orgId).eq("is_active", true);
  const { data: groups } = await admin
    .from("account_groups").select("id, name, account_ids, notion_url")
    .eq("organization_id", orgId);

  type Acct = { id: string; account_name?: string | null; notion_url?: string | null };
  const allowed = (id: string) => accountIds == null || accountIds.includes(String(id));
  const visible = ((accounts ?? []) as Acct[]).filter((a: Acct) => allowed(String(a.id)));

  // Clients are the sheets, not the ad accounts.
  //
  // Grouping by account_groups alone is not enough: Retaj and Retaj 2 share
  // one Notion sheet and belong to no group, so they would appear as two
  // clients with identical figures. Anything sharing a notion_url is one
  // client, which is exactly how the daily report decides.
  const bySheet = new Map<string, typeof visible>();
  const standalone: typeof visible = [];
  for (const a of visible) {
    const url = String(a.notion_url ?? "").trim();
    if (!url) { standalone.push(a); continue; }
    if (!bySheet.has(url)) bySheet.set(url, []);
    bySheet.get(url)!.push(a);
  }

  const groupFor = new Map<string, { id: string; name: string }>();
  for (const g of groups ?? []) {
    const members = ((g.account_ids ?? []) as unknown[]).map(String);
    // A group is only readable when every account under it is. Partial
    // visibility of a combined client would hand over the half they cannot
    // open on its own.
    if (!members.length || !members.every(allowed)) continue;
    const url = String(g.notion_url ?? "").trim();
    if (url) groupFor.set(url, { id: String(g.id), name: String(g.name ?? "Client") });
  }

  const clients: Client[] = [];
  for (const [url, accts] of bySheet) {
    const g = groupFor.get(url);
    // The shortest account name is reliably the client without the "2" or the
    // agency suffix — "Retaj" out of Retaj and Retaj 2.
    const name = g?.name
      ?? accts.map((a: Acct) => String(a.account_name ?? "").trim()).filter(Boolean)
              .sort((x: string, y: string) => x.length - y.length)[0]
      ?? "Client";
    const keys = [...(g ? ["__group__" + g.id] : []), ...accts.map((a: Acct) => String(a.id))];
    clients.push({ name, keys });
  }
  for (const a of standalone) {
    clients.push({ name: String(a.account_name ?? a.id), keys: [String(a.id)] });
  }

  return {
    userId, email, orgId, accountIds, clients,
    keys: clients.flatMap(c => c.keys),
  };
}

/** Resolve whatever the model called a client into the clients it may read. */
function resolveClients(scope: Scope, wanted: string | undefined): Client[] {
  if (!wanted || wanted === "all") return scope.clients;
  const needle = String(wanted).trim().toLowerCase();
  const exact = scope.clients.filter(c => c.name.toLowerCase() === needle);
  if (exact.length) return exact;
  const byKey = scope.clients.filter(c => c.keys.some(k => k.toLowerCase() === needle));
  if (byKey.length) return byKey;
  return scope.clients.filter(c => c.name.toLowerCase().includes(needle)
                                || needle.includes(c.name.toLowerCase()));
}

// ── Tools ─────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "list_accounts",
    description: "List every client account this user can see, with its currency and dashboard template. Call this first when the user names a client, to find the exact name to use.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "daily_figures",
    description: "Day-by-day figures for one client from the team's Notion sheet: spend, revenue, ROAS, website and message orders, message count. Use for questions about a particular period, a drop or spike on a date, or a trend within a month.",
    input_schema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Client name as returned by list_accounts." },
        from: { type: "string", description: "Start date, YYYY-MM-DD." },
        to: { type: "string", description: "End date, YYYY-MM-DD." },
      },
      required: ["account", "from", "to"],
    },
  },
  {
    name: "compare_accounts",
    description: "Totals for every client the user can see over one period: spend, revenue, ROAS, orders. Use for questions that rank or compare clients, such as which is losing money or which improved.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start date, YYYY-MM-DD." },
        to: { type: "string", description: "End date, YYYY-MM-DD." },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "monthly_history",
    description: "Finished months for one client: spend, revenue, orders, pieces, returns percentage. Use for month-on-month comparisons and longer trends.",
    input_schema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Client name as returned by list_accounts." },
        months: { type: "number", description: "How many recent months to return. Default 6, max 24." },
      },
      required: ["account"],
    },
  },
];

async function runTool(scope: Scope, name: string, input: Record<string, unknown>) {
  if (name === "list_accounts") {
    return {
      accounts: scope.clients.map(c => ({ name: c.name, ad_accounts: c.keys.filter(k => !k.startsWith("__group__")).length })),
      note: scope.accountIds == null
        ? "This user can see every client in the organization."
        : `This user is limited to ${scope.clients.length} client(s).`,
    };
  }

  if (name === "daily_figures") {
    const matches = resolveClients(scope, input.account as string);
    if (!matches.length) return { error: `No client matching "${input.account}" that you can read. Call list_accounts.` };
    if (matches.length > 1) {
      return { error: `"${input.account}" matches ${matches.length} clients: ${matches.map(c => c.name).join(", ")}. Ask again with one exact name.` };
    }
    const client = matches[0];
    const { data } = await admin.from("notion_daily").select("*")
      .eq("organization_id", scope.orgId).in("account_key", client.keys)
      .gte("day", String(input.from)).lte("day", String(input.to)).order("day");

    return {
      client: client.name,
      days: pickByDay((data ?? []) as Record<string, unknown>[], client.keys).map(({ day, row }) => {
        const spend = convSpend(row), rev = revenueOf(row);
        return {
          day,
          spend: round(totalSpend(row)), selling_spend: round(spend), revenue: round(rev),
          roas: spend && rev != null ? round(rev / spend) : null,
          website_orders: webOrders(row), message_orders: msgOrders(row),
          messages: num(row.msg_count), reservations: num(row.deals_total),
        };
      }),
    };
  }

  if (name === "compare_accounts") {
    const { data } = await admin.from("notion_daily").select("*")
      .eq("organization_id", scope.orgId).in("account_key", scope.keys)
      .gte("day", String(input.from)).lte("day", String(input.to));
    const rows = (data ?? []) as Record<string, unknown>[];

    const clients = scope.clients.map(c => {
      const mine = rows.filter(r => c.keys.includes(String(r.account_key)));
      let spend = 0, revenue = 0, orders = 0, days = 0;
      for (const { row } of pickByDay(mine, c.keys)) {
        spend += convSpend(row) ?? 0;
        revenue += revenueOf(row) ?? 0;
        orders += webOrders(row) + msgOrders(row);
        days++;
      }
      return {
        name: c.name, spend: round(spend), revenue: round(revenue), orders,
        roas: spend > 0 ? round(revenue / spend) : null, days_recorded: days,
      };
    }).filter(c => c.days_recorded > 0);

    return {
      period: { from: input.from, to: input.to },
      note: "Each client is counted once even where it runs several ad accounts. Currencies differ between clients — do not add them together.",
      clients: clients.sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0)),
    };
  }

  if (name === "monthly_history") {
    const matches = resolveClients(scope, input.account as string);
    if (!matches.length) return { error: `No client matching "${input.account}" that you can read.` };
    const client = matches[0];
    const limit = Math.min(24, Math.max(1, Number(input.months) || 6));
    const { data } = await admin.from("monthly_history").select("*")
      .eq("organization_id", scope.orgId).in("account_key", client.keys)
      .order("month", { ascending: false }).limit(limit * client.keys.length);

    // Same one-row-per-period rule as the daily figures, on months.
    const rank = new Map(client.keys.map((k, i) => [k, i]));
    const best = new Map<string, { r: Record<string, unknown>; rank: number }>();
    for (const r of ((data ?? []) as Record<string, unknown>[])) {
      const kr = rank.get(String(r.account_key));
      if (kr == null) continue;
      const m = String(r.month);
      const cur = best.get(m);
      if (!cur || kr < cur.rank) best.set(m, { r, rank: kr });
    }

    return {
      client: client.name,
      months: [...best.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, limit)
        .map(([month, { r }]) => {
          const spend = (num(r.web_spend) ?? 0) + (num(r.msg_spend) ?? 0);
          const rev = num(r.web_revenue_confirmed) ?? num(r.total_revenue) ?? num(r.web_revenue) ?? 0;
          return {
            month,
            spend: round(spend), revenue: round(rev),
            roas: spend > 0 ? round(rev / spend) : null,
            website_orders: num(r.web_orders_confirmed) ?? num(r.web_orders),
            message_orders: num(r.msg_orders),
            returns_pct: num(r.returns_pct),
          };
        }),
    };
  }

  return { error: `Unknown tool ${name}` };
}

// ── Handler ───────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY is not set on this project." }, 503);

  // The anon key satisfies verify_jwt but identifies nobody, so the user is
  // resolved here and a request that is not a signed-in person is refused.
  const auth = req.headers.get("Authorization") ?? "";
  const { data: userData, error: authErr } = await admin.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
  if (authErr || !userData?.user?.email) return json({ error: "Sign in to use the assistant." }, 401);
  const user = userData.user;

  let body: { organization_id?: string; message?: string; account_hint?: string;
              history?: { role: string; content: string }[] };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const message = String(body.message ?? "").trim();
  if (!message) return json({ error: "message is required" }, 400);
  if (message.length > 4000) return json({ error: "That question is too long." }, 400);
  if (!body.organization_id) return json({ error: "organization_id is required" }, 400);

  const scope = await buildScope(user.id, user.email!, String(body.organization_id));
  if (!scope) return json({ error: "You do not have access to this organization." }, 403);
  if (!scope.clients.length) return json({ reply: "You do not have access to any client accounts yet, so there is nothing for me to look at." , used: [] });

  const today = new Date().toISOString().slice(0, 10);
  const system = `You are an analyst inside Blue Ad's performance dashboard, a marketing agency in Cairo. You answer questions about the agency's own client accounts by looking the figures up with your tools.

Today is ${today}.
${body.account_hint ? `The user is currently looking at: ${body.account_hint}. If they say "this account" or "this client", they mean that one.` : ""}

How to work:
- Look things up before answering. Never estimate a figure you could fetch, and never invent one.
- Call list_accounts when the user names a client, so you use the exact name.
- Figures come from the team's Notion sheets. They stop at the last day the team filled in, which is often one or two days behind. If the last days of a range read zero revenue against real spend, say that the sheet has not been filled yet rather than reporting a collapse.
- Money is in each client's own currency; most are EGP. Never add two currencies together.
- ROAS is revenue divided by selling spend, which excludes branding.

How to answer:
- Lead with the answer, then the evidence. Quote the specific numbers and dates you found.
- Be concise: a few sentences, or a short list. No preamble, no restating the question.
- Say plainly when the data cannot answer something, and what would be needed.
- You can see ${scope.accountIds == null ? "every client" : `${scope.clients.length} client(s)`} in this organization. If asked about a client outside that, say you cannot see it.`;

  const messages: Record<string, unknown>[] = [
    ...(Array.isArray(body.history) ? body.history : [])
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-MAX_HISTORY)
      .map(m => ({ role: m.role, content: m.content })),
    { role: "user", content: message },
  ];

  const used: string[] = [];
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, tools: TOOLS, messages }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const t = await res.text();
        console.error("[ai-chat] anthropic", res.status, t.slice(0, 300));
        return json({ error: `The assistant is unavailable (${res.status}).` }, 502);
      }
      const data = await res.json();
      const content = (data.content ?? []) as Record<string, unknown>[];

      if (data.stop_reason !== "tool_use") {
        const reply = content.filter(c => c.type === "text").map(c => c.text).join("\n").trim();
        return json({ reply: reply || "I could not find an answer to that.", used });
      }

      messages.push({ role: "assistant", content });
      const results = [];
      for (const block of content) {
        if (block.type !== "tool_use") continue;
        used.push(String(block.name));
        let out: unknown;
        try { out = await runTool(scope, String(block.name), (block.input ?? {}) as Record<string, unknown>); }
        catch (e) { out = { error: (e as Error).message }; }
        results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(out).slice(0, 60_000) });
      }
      messages.push({ role: "user", content: results });
    }
    // Out of rounds. Saying so is better than returning the last half-thought.
    return json({ reply: "That took more lookups than I am allowed in one go. Try asking about a narrower period or one client at a time.", used });
  } catch (e) {
    console.error("[ai-chat]", (e as Error).message);
    return json({ error: "The assistant could not finish that request." }, 502);
  }
});
