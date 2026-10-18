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

function blockText(block: any): string {
  const value = block?.[block?.type];
  if (block?.type === "table_row") return (value?.cells || []).map((cell: any) => plain(cell)).filter(Boolean).join(" | ");
  const richText = value?.rich_text || value?.title || [];
  return plain(richText);
}

/**
 * A team member's name out of their task database's title.
 *
 * In Notion the team is not a list of people anywhere -- it is one task
 * database per person per month, named "📋 Eman Tasks", "📋 Hager Tasks".
 * That title is the only place a member's name is actually written down, and
 * it is already fetched, so it is what the roster is built from.
 *
 * This replaces a walk that treated any page under the team whose title ended
 * in "task" as a person. It did not find the databases at all -- those are
 * child_database blocks, not child_page -- and swept up everything else it
 * passed instead: month pages, priority options, section headings, client
 * names and plain task titles. The member filter ended up listing 134
 * "people", among them "Sep", "🔴 High", "Optimize basma" and "قواعد
 * التاسكات".
 *
 * A title is accepted only when something stands in front of the word Tasks:
 * bare "Tasks" and "Tasks Database" are a shared or unnamed board, not a
 * person, and are left out rather than guessed at.
 */
function memberNameFromDatabaseTitle(title: string): string | null {
  const text = String(title || "")
    .replace(/[\p{Extended_Pictographic}️‍]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

  const match = text.match(/^(.*\S)\s+tasks?$/i);
  if (!match) return null;

  const name = match[1].trim();
  if (!name) return null;
  // Words that describe the board rather than name its owner.
  if (/^(the|my|our|all|team|teams|shared|general|daily|weekly|monthly|notion|new|old|archive[d]?|database)$/i.test(name)) {
    return null;
  }
  // A person's name is short. Anything longer is a task that happens to end
  // in the word "tasks" -- "Remaining Reports Tasks" is not somebody.
  if (name.length > 40 || name.split(" ").length > 3) return null;
  return name;
}

/**
 * Which team each task database belongs to.
 *
 * Only to label a member Media Buying or Social Media; the names themselves
 * come from the database titles. Walking the two team pages for their
 * child_database blocks is a handful of requests, and a team page that cannot
 * be read costs its members their label, not their place in the list.
 */
async function notionTeamRoster(
  notionRequest: (path: string, init?: RequestInit) => Promise<any>,
  rootPageId: string,
) {
  const blockChildren = async (id: string) => {
    const rows: any[] = [];
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({ page_size: "100" });
      if (cursor) params.set("start_cursor", cursor);
      const result = await notionRequest(`/blocks/${id}/children?${params}`);
      rows.push(...(result.results || []));
      cursor = result.has_more ? result.next_cursor : undefined;
    } while (cursor);
    return rows;
  };

  const teams: { id: string; name: string; department: string }[] = [];
  const queue = [{ id: rootPageId, depth: 0 }];
  const visited = new Set<string>();
  while (queue.length && visited.size < 100) {
    const current = queue.shift()!;
    if (visited.has(current.id) || current.depth > 4) continue;
    visited.add(current.id);
    for (const block of await blockChildren(current.id)) {
      if (block.type !== "child_page") continue;
      const title = String(block.child_page?.title || "").trim();
      const department = /media\s*buying/i.test(title) ? "Media Buying" :
        /social\s*media/i.test(title) ? "Social Media" : "";
      if (department && /team/i.test(title)) teams.push({ id: block.id, name: title, department });
      else if (current.depth < 4) queue.push({ id: block.id, depth: current.depth + 1 });
    }
  }

  // database id -> { team page, department }
  const byDatabase = new Map<string, { teamPageId: string; department: string }>();
  const inaccessibleTeams: string[] = [];
  for (const team of teams) {
    try {
      const blocks = [{ id: team.id, depth: 0 }];
      const seen = new Set<string>();
      while (blocks.length && seen.size < 200) {
        const current = blocks.shift()!;
        if (seen.has(current.id) || current.depth > 4) continue;
        seen.add(current.id);
        for (const block of await blockChildren(current.id)) {
          if (block.type === "child_database") {
            byDatabase.set(block.id, { teamPageId: team.id, department: team.department });
          } else if (block.type === "child_page" && current.depth < 4) {
            blocks.push({ id: block.id, depth: current.depth + 1 });
          }
        }
      }
    } catch {
      inaccessibleTeams.push(team.name);
    }
  }
  return { byDatabase, inaccessibleTeams, foundTeams: teams.length };
}

/**
 * The roster itself: one row per person, from the task databases they own.
 *
 * A person owns a database per month, so the same name arrives several times
 * and is folded into one entry. The key is the name rather than the database,
 * which is why re-importing a new month does not add a second "Eman".
 */
function rosterFromDatabases(
  databases: any[],
  byDatabase: Map<string, { teamPageId: string; department: string }>,
  fallbackTeamPageId: string,
) {
  const people = new Map<string, any>();
  for (const database of databases) {
    const name = memberNameFromDatabaseTitle(plain(database.title));
    if (!name) continue;
    const key = name.toLowerCase();
    const team = byDatabase.get(database.id);
    const existing = people.get(key);
    // First sighting wins, except that a labelled team beats an unlabelled one.
    if (existing && (existing.department || !team?.department)) continue;
    people.set(key, {
      notion_page_id: team?.teamPageId || fallbackTeamPageId,
      notion_person_key: `roster:${key}`,
      full_name: name,
      email: null,
      department: team?.department || "",
    });
  }
  return [...people.values()];
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
  let notionHost = "";
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.protocol === "https:") notionHost = parsed.hostname.toLowerCase();
  } catch { /* Invalid URL is reported below. */ }
  const validNotionHost = notionHost === "notion.so" || notionHost.endsWith(".notion.so") ||
    notionHost === "notion.com" || notionHost.endsWith(".notion.com");
  if (!orgId || !databaseId || !validNotionHost) {
    return json({ error: "Provide a valid Notion database link and organization." }, 400);
  }
  let teamRootPageId: string | null = null;
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
    // Accept either a database link or a page link. The Blue Ad HQ URL users
    // commonly copy is a page containing the task database, so discover
    // databases below that page instead of sending the page ID to /databases.
    const databases: any[] = [];
    try {
      const database = await notionRequest(`/databases/${databaseId}`);
      databases.push(database);
    } catch (databaseError) {
      // A page ID is expected to fail the database endpoint. Confirm it is an
      // accessible page, then search the connection's shared data sources for
      // task databases before walking the page tree. The search API is much
      // cheaper for large workspace home pages.
      const rootPage = await notionRequest(`/pages/${databaseId}`);
      teamRootPageId = rootPage.id || databaseId;
      const search = await notionRequest("/search", {
        method: "POST",
        body: JSON.stringify({
          query: "Task", page_size: 100,
          filter: { property: "object", value: "data_source" },
        }),
      });
      for (const source of search.results || []) {
        if (!/task/i.test(plain(source.title))) continue;
        const parentDatabaseId = source.parent?.database_id;
        if (!parentDatabaseId || databases.some((item) => item.id === parentDatabaseId)) continue;
        databases.push({
          id: parentDatabaseId,
          title: source.title,
          data_sources: [{ id: source.id }],
        });
      }

      // Search only returns title matches. If none match, inspect the linked
      // page hierarchy as a fallback for databases with unrelated names.
      if (!databases.length) {
        const queue: { id: string; depth: number }[] = [{ id: rootPage.id || databaseId, depth: 0 }];
        const visited = new Set<string>();
        const maxDepth = 8;
        const maxPages = 500;
        while (queue.length && visited.size < maxPages) {
          const node = queue.shift()!;
          if (visited.has(node.id) || node.depth > maxDepth) continue;
          visited.add(node.id);
          let cursor: string | undefined;
          do {
            const params = new URLSearchParams({ page_size: "100" });
            if (cursor) params.set("start_cursor", cursor);
            const children = await notionRequest(`/blocks/${node.id}/children?${params}`);
            for (const block of children.results || []) {
              if (block.type === "child_database") {
                const id = block.id;
                if (!databases.some((item) => item.id === id)) {
                  databases.push(await notionRequest(`/databases/${id}`));
                }
              } else if (block.type === "child_page" && node.depth < maxDepth) {
                queue.push({ id: block.id, depth: node.depth + 1 });
              }
            }
            cursor = children.has_more ? children.next_cursor : undefined;
          } while (cursor);
        }
      }
      if (!databases.length) {
        const original = databaseError instanceof Error ? databaseError.message : "";
        throw new Error(original.includes("could not access")
          ? "Notion could not access this page. Share the page and its task database with the Blue Ad Notion integration, then try again."
          : "No task database was found on this Notion page or its nested pages. Open the task database in Notion and paste its link, or move it under this page.");
      }
    }

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
    const taskDatabaseIds = new Map<string, string>();
    for (const database of databases) {
      const dataSourceId = database.data_sources?.[0]?.id;
      if (!dataSourceId) continue;
      let cursor: string | undefined;
      for (let i = 0; i < 20; i++) {
        const result = await notionRequest(`/data_sources/${dataSourceId}/query`, {
          method: "POST", body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
        });
        for (const page of result.results || []) {
          pages.push(page);
          taskDatabaseIds.set(page.id, database.id);
        }
        if (!result.has_more || !result.next_cursor) break;
        cursor = result.next_cursor;
      }
    }
    if (!databases.some((database) => database.data_sources?.length)) {
      throw new Error("No task data source was found in the accessible Notion database(s).");
    }

    let teamMembers: any[] = [];
    let teamRosterWarning: string | null = null;
    if (teamRootPageId) {
      const teamRoster = await notionTeamRoster(notionRequest, teamRootPageId);
      teamMembers = rosterFromDatabases(databases, teamRoster.byDatabase, teamRootPageId);
      if (teamRoster.inaccessibleTeams.length) {
        teamRosterWarning = `Share these Notion pages with the Blue Ad integration, then import again: ${teamRoster.inaccessibleTeams.join(", ")}.`;
      } else if (!teamMembers.length) {
        teamRosterWarning = "No task database named after a person (such as “📋 Eman Tasks”) was found, " +
          "so the member list could not be built.";
      }
      if (teamMembers.length) {
        const { error: clearRosterError } = await admin.from("blue_ad_task_assignees").delete()
          .eq("organization_id", orgId);
        if (clearRosterError) throw new Error(`The old Notion member list could not be cleared. ${clearRosterError.message}`);
        const { error: rosterError } = await admin.from("blue_ad_task_assignees").upsert(
          teamMembers.map((person) => ({ organization_id: orgId, ...person, updated_at: new Date().toISOString() })),
          { onConflict: "organization_id,notion_person_key" },
        );
        if (rosterError) throw new Error(`The Notion team roster could not be saved. Apply migration 20240108000000_blue_ad_notion_team_roster.sql in Supabase, then retry. ${rosterError.message}`);
      }
    }
    const notionPersonMap = new Map<string, any>();
    for (const person of teamMembers) {
      if (person.full_name) notionPersonMap.set(norm(person.full_name), person);
      if (person.email) notionPersonMap.set(norm(person.email), person);
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
      const matchNotionPerson = notionPersonMap.get(norm(personName));
      const clientName = propText(clientProp);
      const matchClient = clientMap.get(norm(clientName));
      return {
        organization_id: orgId, title: title.slice(0, 180), description: description.slice(0, 2000) || null,
        client_id: matchClient?.id || null, client_name: clientName || matchClient?.name || null,
        assignee_member_id: matchMember?.id || null, assignee_name: matchMember?.full_name || personName || null,
        assignee_email: matchMember?.email || matchNotionPerson?.email || (person?.type === "email" ? person.email : null),
        due_date: due?.date?.start ? String(due.date.start).slice(0, 10) : null,
        category: (category || "Other").slice(0, 80), priority: priorityValue(priority), status: statusValue(status),
        created_by: auth.user!.id, notion_page_id: page.id,
        notion_database_id: taskDatabaseIds.get(page.id) || databases[0].id,
      };
    });

    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await admin.from("blue_ad_tasks").upsert(rows.slice(i, i + 100), {
        onConflict: "organization_id,notion_page_id",
      });
      if (error) throw new Error(`Could not save imported tasks: ${error.message}`);
    }
    const sourceRows = databases.filter((database) => database.data_sources?.length).map((database) => ({
      organization_id: orgId, notion_database_id: database.id,
      database_url: database.id === databaseId ? databaseUrl : `https://www.notion.so/${database.id.replaceAll("-", "")}`,
      database_title: plain(database.title) || "Notion task database", created_by: auth.user.id,
      last_synced_at: new Date().toISOString(),
      sync_note: `Imported ${pages.filter((page) => taskDatabaseIds.get(page.id) === database.id).length} tasks`,
    }));
    const { error: sourceError } = await admin.from("blue_ad_task_sources").upsert(sourceRows, {
      onConflict: "organization_id,notion_database_id",
    });
    if (sourceError) throw new Error(`Tasks imported, but source details could not be saved: ${sourceError.message}`);

    const updated = rows.filter((row) => existing.has(row.notion_page_id)).length;
    return json({ ok: true, imported: rows.length - updated, updated, total: rows.length,
      databases: databases.length, team_members: teamMembers.length, team_roster_warning: teamRosterWarning,
      database_titles: databases.map((database) => plain(database.title) || "Notion task database") });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Notion import failed." }, 400);
  }
});
