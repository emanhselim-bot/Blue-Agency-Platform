/**
 * Teachable sales -> dashboard revenue
 *
 * Course clients have no Shopify store, and a website tracker cannot help:
 * Teachable refuses custom code on its checkout and thank-you pages, so a
 * snippet there sees sessions and never a sale. Their API is the only honest
 * source, and it also reaches back over past months, which a pixel never can.
 *
 * GET /v1/transactions takes start (exclusive) and end (inclusive) in ISO8601,
 * and pages with page/per.
 *
 * The API key lives in teachable_schools and is read here on the service role.
 * It is never returned, and the browser reads schools through
 * teachable_schools_safe, which does not carry it.
 *
 * `probe: true` returns one raw transaction instead of totals. Teachable's
 * response shape is not documented field by field, and guessing which key holds
 * the money — or whether it is in cents — is how a dashboard ends up a hundred
 * times out. So the amount field is confirmed against a real response before
 * any figure is trusted, and until it is, unmatched shapes report null rather
 * than a plausible-looking zero.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const API = "https://developers.teachable.com/v1";
const MAX_PAGES = 50;
const PER = 100;

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

// Candidate names for the gross charged to the student, best first. Teachable
// has used several across versions; whichever is present is reported alongside
// the total so the dashboard can say what it measured.
const AMOUNT_KEYS = [
  "final_price", "amount", "total", "charge_amount", "price", "purchase_price",
];

function pickAmount(t: Record<string, unknown>): { value: number | null; field: string | null } {
  for (const k of AMOUNT_KEYS) {
    const v = t[k];
    if (v != null && !isNaN(Number(v))) return { value: Number(v), field: k };
  }
  return { value: null, field: null };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const auth = req.headers.get("Authorization");
  if (!auth) return json({ error: "Unauthorized" }, 401);
  const { data: { user }, error: authErr } = await admin.auth.getUser(auth.replace("Bearer ", ""));
  if (authErr || !user) return json({ error: "Unauthorized" }, 401);

  let body: { school_id?: string; since?: string; until?: string; probe?: boolean };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  const { school_id, since, until, probe = false } = body;
  if (!school_id) return json({ error: "school_id is required" }, 400);

  const { data: school } = await admin
    .from("teachable_schools")
    .select("id, organization_id, name, api_key, currency, is_active")
    .eq("id", school_id)
    .maybeSingle();

  if (!school || !school.is_active) return json({ error: "School not found" }, 404);
  if (!school.api_key) return json({ error: "NO_API_KEY" }, 422);

  const { data: member } = await admin
    .from("organization_members")
    .select("id")
    .eq("organization_id", school.organization_id)
    .eq("user_id", user.id)
    .not("accepted_at", "is", null)
    .maybeSingle();
  if (!member) return json({ error: "Forbidden" }, 403);

  // start is exclusive, so step back a second to keep the first day whole.
  const startISO = since ? new Date(new Date(since + "T00:00:00Z").getTime() - 1000).toISOString() : undefined;
  const endISO   = until ? new Date(until + "T23:59:59Z").toISOString() : undefined;

  const all: Record<string, unknown>[] = [];
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const p = new URLSearchParams({ page: String(page), per: String(PER) });
      if (startISO) p.set("start", startISO);
      if (endISO)   p.set("end", endISO);

      const res = await fetch(`${API}/transactions?${p}`, {
        headers: { apiKey: school.api_key, Accept: "application/json" },
      });

      if (res.status === 401 || res.status === 403) return json({ error: "BAD_API_KEY" }, 401);
      if (res.status === 429) return json({ error: "RATE_LIMITED" }, 429);
      if (!res.ok) return json({ error: `Teachable returned ${res.status}` }, 502);

      const j = await res.json();
      const rows: Record<string, unknown>[] = j.transactions ?? j.data ?? (Array.isArray(j) ? j : []);
      all.push(...rows);
      if (rows.length < PER) break;
    }
  } catch (e) {
    console.error("Teachable unreachable:", e);
    return json({ error: "Teachable API unreachable" }, 502);
  }

  await admin.from("teachable_schools")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", school.id);

  // Refunds and chargebacks are not revenue.
  const live = all.filter(t => t.is_fully_refunded !== true && t.is_chargeback !== true);

  if (probe) {
    return json({
      school: school.name,
      fetched: all.length,
      after_refunds: live.length,
      // One whole transaction, so the money field and its units can be read off
      // real data rather than assumed.
      sample: all[0] ?? null,
      amount_keys_present: all[0] ? AMOUNT_KEYS.filter(k => (all[0] as Record<string, unknown>)[k] != null) : [],
    });
  }

  let revenue = 0, counted = 0;
  let field: string | null = null;
  for (const t of live) {
    const { value, field: f } = pickAmount(t);
    if (value == null) continue;
    revenue += value;
    counted++;
    field ??= f;
  }

  // If not one transaction carried a recognised amount, say so. A zero here
  // would read as "no sales", which is a different and much worse claim.
  const measured = counted > 0 || live.length === 0;

  return json({
    school: school.name,
    currency: school.currency ?? null,
    orders: live.length,
    pieces: live.length,          // one enrolment per transaction
    revenue: measured ? revenue : null,
    amount_field: field,
    unmatched: live.length - counted,
    refunded: all.length - live.length,
    since: since ?? null,
    until: until ?? null,
  });
});
