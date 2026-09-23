/**
 * Daily FX snapshot
 *
 * Accounts bill in EGP, USD, SAR, AED and EUR. Reporting is in EGP, so every
 * other currency needs a rate, and it has to be the rate for the day the money
 * came in -- otherwise a closed month changes value every morning.
 *
 * open.er-api.com gives live rates for 166 currencies with no key, but no
 * history on the free tier. So the history is built here: one snapshot a day,
 * stored permanently. From the first run onward every day has its own rate.
 *
 * Rates are written for whole days. Re-running on the same day overwrites that
 * day's row rather than adding another, so a retry after a failure is safe.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const QUOTE = "EGP";
const SOURCE = "open.er-api.com";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // Which currencies are actually in use, so this never fetches noise.
  const bases = new Set<string>();
  for (const t of ["meta_ad_accounts", "site_trackers", "teachable_schools"]) {
    const { data } = await admin.from(t).select("currency");
    for (const r of data ?? []) {
      const c = (r as { currency?: string }).currency;
      if (c && c !== QUOTE) bases.add(c.toUpperCase());
    }
  }
  if (!bases.size) return json({ ok: true, note: "no non-EGP currencies in use", written: 0 });

  // One call: rates from EGP to everything, then inverted. Asking per-base
  // would be a call each and they would not share a timestamp.
  let body: { result?: string; rates?: Record<string, number>; time_last_update_utc?: string };
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${QUOTE}`);
    body = await res.json();
    if (!res.ok || body.result !== "success" || !body.rates) {
      return json({ error: "rate source returned no usable rates" }, 502);
    }
  } catch (e) {
    console.error("FX source unreachable:", e);
    return json({ error: "rate source unreachable" }, 502);
  }

  // Date the rates belong to, from the source rather than our own clock.
  const stamp = body.time_last_update_utc ? new Date(body.time_last_update_utc) : new Date();
  const rateDate = stamp.toISOString().slice(0, 10);

  const rows: Record<string, unknown>[] = [];
  const missing: string[] = [];
  for (const base of bases) {
    const perEgp = body.rates[base];          // how many <base> one EGP buys
    if (!perEgp || perEgp <= 0) { missing.push(base); continue; }
    rows.push({
      rate_date: rateDate,
      base,
      quote: QUOTE,
      rate: 1 / perEgp,                        // 1 base = <rate> EGP
      source: SOURCE,
      fetched_at: new Date().toISOString(),
    });
  }

  if (!rows.length) return json({ error: "no rates matched the currencies in use", missing }, 502);

  const { error } = await admin.from("fx_rates")
    .upsert(rows, { onConflict: "rate_date,base,quote" });
  if (error) return json({ error: error.message }, 500);

  return json({
    ok: true,
    rate_date: rateDate,
    source: SOURCE,
    written: rows.length,
    rates: Object.fromEntries(rows.map(r => [r.base as string, Number(r.rate)])),
    missing,
  });
});
