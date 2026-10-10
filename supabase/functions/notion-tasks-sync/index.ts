import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, "Content-Type": "application/json" },
});

function notionId(input: string): string | null {
  const found = input.match(/[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!found) return null;
  const compact = found[0].replaceAll("-", "").toLowerCase();
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}
const plain = (value: any): string => Array.isArray(value)
  ? value.map((part) => part?.plain_text || part?.name || "").join("").trim()
  : "";
function propText(prop: any): string {
  if (!prop) return "";
  if (prop.type === "title") return plain(prop.title);
  if (prop.type === "rich_text") return plain(prop.rich_text);
  if (prop.type === "select" || prop.type === "status") return prop[prop.type]?.name || "";
  if (prop.type === "people") return (prop.people || []).map((p: any) => p.name || p.person?.email || "").join(", ");
  if (prop.type === "email") return prop.email || "";
  if (prop.type === "url") return prop.url || "";
  if (prop.type === "number") return prop.number == null ? "" : String(prop.number);
  return "";
}
const norm = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
function pick(props: Record<string, any>, pattern: RegExp, types?: string[]) {
  return Object.entries(props).find(([name, value]) => pattern.test(name) && (!types || types.includes(value.type)))?.[1];
}
function statusValue(value: string) {
  const s = norm(value);
  if (/done|complete|closed|finished/.test(s)) return "done";
  if (/review|approval|qa/.test(s)) return "review";
  if (/progress|doing|started|active/.test(s)) return "in_progress";
  return "todo";
}
function priorityValue(value: string) {
  const s = norm(value);
  if (/urgent|critical|immediate/.test(s)) return "urgent";
  if (/high|important/.test(s)) return "high";
  if (/low/.test(s)) return "low";
  return "medium";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  const token = Deno.env.get("NOTION_API_KEY");
  if (!token) return json({ error: "Notion is not connected on the server." }, 503);

  const jwt = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Sign in to import tasks." }, 401);
  const { data: auth, error: authError } = await admin.auth.getUser(jwt);
  if (authError || !auth.user) return json({ error: "Your session expired. Sign in and try again." }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const orgId = String(body.organization_id || "");
  const databaseUrl = String(body.database_url || "").trim();
  const databaseId = notionId(databaseUrl);
  if (!orgId || !databaseId || !/^https:\/\/(www\.)?notion\.so\//i.test(databaseUrl)) {
    return json({ error: "Provide a valid Notion database link and organization." }, 400);
  }
  const { data: member } = await admin.from("organization_members").select("id")
    .eq("organization_id", orgId).eq("user_id", auth.user.id).not("accepted_at", "is", null).maybeSingle();
  if (!member) return json({ error: "You do not have access to this organization." }, 403);

  const notionRequest = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${NOTION_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json", ...(init.headers || {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = response.status === 404 || response.status === 403
        ? "Notion could not access that database. Share it with the Blue Ad Notion integration, then try again."
        : (data.message || `Notion returned an error (${response.status}).`);
      throw new Error(message);
    }
    return data;
  };

  try {
    const database = await notionRequest(`/databases/${databaseId}`);
    const databaseTitle = plain(database.title) || "Notion task database";
    const dataSourceId = database.data_sources?.[0]?.id;
    if (!dataSourceId) throw new Error("No task data source was found in that Notion database.");
    const { data: clients } = await admin.from("pipeline_clients").select("id,name").eq("organization_id", orgId);
    const { data: members } = await admin.from("cp_members").select("id,full_name,email")
      .eq("organization_id", orgId).eq("archived", false);
    const clientMap = new Map((clients || []).map((c: any) => [norm(c.name), c]));
    const memberMap = new Map<string, any>();
    for (const m of members || []) {
      if (m.full_name) memberMap.set(norm(m.full_name), m);
      if (m.email) memberMap.set(norm(m.email), m);
    }

    const pages: any[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await notionRequest(`/data_sources/${dataSourceId}/query`, {
        method: "POST", body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
      });
      pages.push(...(page.results || []));
      if (!page.has_more || !page.next_cursor) break;
      cursor = page.next_cursor;
    }

    const pageIds = pages.map((p) => p.id);
    const existing = new Set<string>();
    for (let i = 0; i < pageIds.length; i += 200) {
      const { data, error } = await admin.from("blue_ad_tasks").select("notion_page_id")
        .eq("organization_id", orgId).in("notion_page_id", pageIds.slice(i, i + 200));
      if (error) throw new Error(`Could not check existing imported tasks: ${error.message}`);
      for (const row of data || []) if (row.notion_page_id) existing.add(row.notion_page_id);
    }

    const rows = pages.map((page) => {
      const props = page.properties || {};
      const titleProp = Object.values(props).find((p: any) => p?.type === "title") as any;
      const title = plain(titleProp?.title) || "Untitled Notion task";
      const status = propText(pick(props, /status|state|stage/i, ["status", "select"]));
      const priority = propText(pick(props, /priority|importance/i, ["select", "status"]));
      const category = propText(pick(props, /category|type|team|department/i, ["select", "status", "rich_text"]));
      const due = pick(props, /due|deadline|date/i, ["date"]);
      const person = pick(props, /assignee|owner|assigned|person/i, ["people", "email", "rich_text", "select"]);
      const clientProp = pick(props, /client|account|brand/i, ["select", "rich_text", "title"]);
      const description = propText(pick(props, /description|notes|details|brief/i, ["rich_text"]));
      const personName = propText(person);
      const matchMember = memberMap.get(norm(personName));
      const clientName = propText(clientProp);
      const matchClient = clientMap.get(norm(clientName));
      return {
        organization_id: orgId, title: title.slice(0, 180), description: description.slice(0, 2000) || null,
        client_id: matchClient?.id || null, client_name: clientName || matchClient?.name || null,
        assignee_member_id: matchMember?.id || null, assignee_name: matchMember?.full_name || personName || null,
        assignee_email: matchMember?.email || (person?.type === "email" ? person.email : null),
        due_date: due?.date?.start ? String(due.date.start).slice(0, 10) : null,
        category: (category || "Other").slice(0, 80), priority: priorityValue(priority), status: statusValue(status),
        created_by: auth.user!.id, notion_page_id: page.id, notion_database_id: databaseId,
      };
    });

    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await admin.from("blue_ad_tasks").upsert(rows.slice(i, i + 100), {
        onConflict: "organization_id,notion_page_id",
      });
      if (error) throw new Error(`Could not save imported tasks: ${error.message}`);
    }
    const { error: sourceError } = await admin.from("blue_ad_task_sources").upsert({
      organization_id: orgId, notion_database_id: databaseId, database_url: databaseUrl,
      database_title: databaseTitle, created_by: auth.user.id,
      last_synced_at: new Date().toISOString(), sync_note: `Imported ${rows.length} tasks`,
    }, { onConflict: "organization_id,notion_database_id" });
    if (sourceError) throw new Error(`Tasks imported, but source details could not be saved: ${sourceError.message}`);

    const updated = rows.filter((row) => existing.has(row.notion_page_id)).length;
    return json({ ok: true, imported: rows.length - updated, updated, total: rows.length, database_title: databaseTitle });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Notion import failed." }, 400);
  }
});
