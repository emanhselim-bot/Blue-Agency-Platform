/**
 * ai-chat — Supabase Edge Function
 * Deploy: supabase functions deploy ai-chat
 *
 * Calls Anthropic Claude with Meta Ads dashboard context.
 * Required secret: ANTHROPIC_API_KEY
 *
 * POST body: { message: string, context: object }
 * Returns:   { reply: string }
 */

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const { message, context } = await req.json();

    if (!message || typeof message !== "string") {
      return jsonResponse({ error: "message (string) required" }, 400);
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return jsonResponse({ error: "ANTHROPIC_API_KEY not configured" }, 500);
    }

    // Build a concise context summary so the system prompt is actionable
    const ctxLines: string[] = [];
    if (context) {
      if (context.accountName) ctxLines.push(`Account: ${context.accountName}`);
      if (context.period)      ctxLines.push(`Period: ${context.period}`);
      if (context.currency)    ctxLines.push(`Currency: ${context.currency}`);
      if (context.spend != null)       ctxLines.push(`Total Spend: ${context.currency || ''}${context.spend?.toFixed?.(2) ?? context.spend}`);
      if (context.impressions != null) ctxLines.push(`Impressions: ${Number(context.impressions).toLocaleString('en')}`);
      if (context.reach != null)       ctxLines.push(`Reach: ${Number(context.reach).toLocaleString('en')}`);
      if (context.clicks != null)      ctxLines.push(`Clicks: ${Number(context.clicks).toLocaleString('en')}`);
      if (context.ctr != null)         ctxLines.push(`CTR: ${Number(context.ctr).toFixed(2)}%`);
      if (context.cpm != null)         ctxLines.push(`CPM: ${context.cpm?.toFixed?.(2) ?? context.cpm}`);
      if (context.cpc != null)         ctxLines.push(`CPC: ${context.cpc?.toFixed?.(2) ?? context.cpc}`);
      if (context.frequency != null)   ctxLines.push(`Frequency: ${Number(context.frequency).toFixed(2)}`);
      if (context.results != null)     ctxLines.push(`Results (messages/conversions): ${Number(context.results).toLocaleString('en')}`);
      if (context.costPerResult != null) ctxLines.push(`Cost per Result: ${context.costPerResult?.toFixed?.(2) ?? context.costPerResult}`);
      if (context.shopifyOrders != null) ctxLines.push(`Shopify Orders: ${context.shopifyOrders}`);
      if (context.revenue != null)     ctxLines.push(`Revenue: ${context.revenue}`);
      if (context.roas != null)        ctxLines.push(`ROAS: ${Number(context.roas).toFixed(2)}x`);
      if (context.pieces != null)      ctxLines.push(`Units Sold: ${context.pieces}`);
      if (context.returns != null)     ctxLines.push(`Returns: ${context.returns}`);
      if (context.sessions != null)    ctxLines.push(`Sessions: ${context.sessions}`);
      if (context.conversionRate != null) ctxLines.push(`Conversion Rate: ${Number(context.conversionRate).toFixed(2)}%`);

      if (Array.isArray(context.campaigns) && context.campaigns.length) {
        ctxLines.push("\nTop Campaigns:");
        context.campaigns.slice(0, 8).forEach((c: Record<string, unknown>) => {
          ctxLines.push(`  - ${c.name}: spend=${c.spend}, results=${c.results}, cpr=${c.costPerResult}`);
        });
      }

      if (Array.isArray(context.platforms) && context.platforms.length) {
        ctxLines.push("\nPlatform Breakdown:");
        context.platforms.forEach((p: Record<string, unknown>) => {
          ctxLines.push(`  - ${p.platform}: spend=${p.spend}, results=${p.results}`);
        });
      }

      if (Array.isArray(context.topAds) && context.topAds.length) {
        ctxLines.push("\nTop Ads:");
        context.topAds.forEach((a: Record<string, unknown>) => {
          ctxLines.push(`  - ${a.name}: spend=${a.spend}, results=${a.results}, cpr=${a.costPerResult}`);
        });
      }

      if (Array.isArray(context.topRegions) && context.topRegions.length) {
        ctxLines.push("\nTop Regions:");
        context.topRegions.forEach((r: Record<string, unknown>) => {
          ctxLines.push(`  - ${r.region}: spend=${r.spend}, results=${r.results}`);
        });
      }

      if (Array.isArray(context.topProducts) && context.topProducts.length) {
        ctxLines.push("\nTop Products:");
        context.topProducts.forEach((p: unknown[]) => {
          ctxLines.push(`  - ${p[0]}: qty=${p[1]}, revenue=${p[2]}`);
        });
      }
    }

    const systemPrompt = `You are an expert digital marketing analyst embedded in a Meta Ads performance dashboard. Your role is to help the user understand their ad performance and give specific, actionable advice on targeting, creatives, budget allocation, and campaign optimisation.

Current dashboard data:
${ctxLines.length ? ctxLines.join("\n") : "No data loaded — tell the user to load a dashboard account first."}

Guidelines:
- Be concise and direct. 3-5 sentences max unless the user asks for detail.
- Reference specific numbers from the data above when relevant.
- Focus on actionable next steps, not generic advice.
- If data is missing or zero, acknowledge it briefly and give relevant general advice.
- Use a professional but conversational tone.`;

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: "user", content: message }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return jsonResponse({ error: `Anthropic API error (${anthropicRes.status}): ${errText.slice(0, 300)}` }, 500);
    }

    const data = await anthropicRes.json();
    const reply = data.content?.[0]?.text ?? "No response generated.";
    return jsonResponse({ reply });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: msg }, 500);
  }
});
