/**
 * Notion page discovery
 *
 * Walks the tree under a Notion page and reports its shape: which pages sit
 * beneath it, how deep each one is, and how many month databases it holds. It
 * reads no figures at all.
 *
 * Why it exists: attaching a client's sheet means somebody opens every client
 * page in Notion and copies its URL, one at a time. Pointing this at "Media
 * Buying Performance Reports" lists every client page underneath with a usable
 * link, so an account can be matched to its sheet by name instead.
 *
 * Why it is its own function rather than a flag on notion-sync: that one runs
 * on a cron every six hours and is the only path the dashboard's figures take.
 * A read-only lookup has no business being deployed over it. The cost is the
 * fetch helper and the id parser appearing twice; the benefit is that getting
 * this wrong cannot stop the figures arriving.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const NOTION = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const MAX_DEPTH = 5;
const MAX_NODES = 400;

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

function idFromUrl(raw: string): string | null {
  let path = raw.trim();
  try { path = new URL(path.startsWith("http") ? path : "https://" + path).pathname; } catch { /* bare id */ }
  const hits = path.match(/[0-9a-f]{32}/gi);
  if (hits?.length) return hits[hits.length - 1].toLowerCase();
  const dashed = path.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return dashed ? dashed[0].replace(/-/g, "").toLowerCase() : null;
}

// Notion allows roughly three requests a second per integration, and this walk
// is one request per page, so it is paced exactly as the sync is.
let _lastCall = 0;
const MIN_GAP_MS = 350;

// deno-lint-ignore no-explicit-any
async function notion(token: string, path: string): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = _lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastCall = Date.now();
    const res = await fetch(NOTION + path, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
    });
    if (res.status === 429) {
      const retry = Number(res.headers.get("Retry-After") || "1");
      await new Promise(r => setTimeout(r, Math.min(retry, 10) * 1000 * (attempt + 1)));
      continue;
    }
    if (res.status === 401) throw new Error("BAD_NOTION_TOKEN");
    if (res.status === 404) throw new Error("NOT_SHARED");
    if (!res.ok) throw new Error(`Notion returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return await res.json();
  }
  throw new Error("RATE_LIMITED");
}

type Node = { id: string; title: string; depth: number; parent: string };

async function discover(token: string, rootId: string) {
  const out: {
    id: string; title: string; depth: number; parent: string;
    databases: number; sample: string[]; url: string;
  }[] = [];
  const seen = new Set<string>();
  let queue: Node[] = [{ id: rootId, title: "(root)", depth: 0, parent: "" }];
  let visited = 0;

  while (queue.length && visited < MAX_NODES) {
    const next: Node[] = [];
    for (const node of queue) {
      if (visited >= MAX_NODES) break;
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      visited++;

      const dbs: string[] = [];
      let cursor: string | undefined;
      do {
        const q = new URLSearchParams({ page_size: "100" });
        if (cursor) q.set("start_cursor", cursor);
        let page: { results?: Record<string, unknown>[]; next_cursor?: string; has_more?: boolean };
        try {
          page = await notion(token, `/blocks/${node.id}/children?${q}`);
        } catch (e) {
          const msg = (e as Error).message;
          // A bad token or a rate limit is about the whole walk; one unshared
          // or deleted child is not, and must not abort it.
          if (msg === "BAD_NOTION_TOKEN" || msg === "RATE_LIMITED") throw e;
          break;
        }
        for (const b of page.results ?? []) {
          const type = b.type as string;
          if (type === "child_database") {
            dbs.push(String((b.child_database as { title?: string })?.title ?? "").trim());
          } else if (type === "child_page" && node.depth < MAX_DEPTH) {
            next.push({
              id: String(b.id).replace(/-/g, ""),
              title: String((b.child_page as { title?: string })?.title ?? "").trim(),
              depth: node.depth + 1,
              parent: node.title,
            });
          }
        }
        cursor = page.has_more ? page.next_cursor : undefined;
      } while (cursor);

      out.push({
        id: node.id, title: node.title, depth: node.depth, parent: node.parent,
        databases: dbs.length, sample: dbs.slice(0, 3),
        url: "https://app.notion.com/p/" + node.id,
      });
    }
    queue = next;
  }
  return { nodes: out, visited, truncated: visited >= MAX_NODES };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const token = Deno.env.get("NOTION_API_KEY");
  if (!token) return json({ error: "NO_NOTION_TOKEN" }, 422);

  let body: { url?: string; cron_secret?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  // The same two callers the sync accepts: the shared secret, or a signed-in
  // member of an organization. Reading the workspace structure is not public.
  if (body.cron_secret) {
    const { data: secret } = await admin
      .from("app_secrets").select("value").eq("key", "notion_cron").maybeSingle();
    if (!secret?.value || secret.value !== body.cron_secret) {
      return json({ error: "Unauthorized" }, 401);
    }
  } else {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const { data: { user }, error } = await admin.auth.getUser(auth.replace("Bearer ", ""));
    if (error || !user) return json({ error: "Unauthorized" }, 401);
    const { data: member } = await admin.from("organization_members")
      .select("id").eq("user_id", user.id).not("accepted_at", "is", null).limit(1).maybeSingle();
    if (!member) return json({ error: "Forbidden" }, 403);
  }

  const rootId = body.url ? idFromUrl(body.url) : null;
  if (!rootId) return json({ error: "A Notion url is required" }, 400);

  try {
    const tree = await discover(token, rootId);
    return json({ ok: true, ...tree });
  } catch (e) {
    const msg = (e as Error).message || "failed";
    return json({ error: msg }, msg === "BAD_NOTION_TOKEN" ? 401 : 500);
  }
});
