-- Keep Notion page identity on imported tasks so repeated imports update rows.
alter table public.blue_ad_tasks
  add column if not exists notion_page_id text,
  add column if not exists notion_database_id text;

create unique index if not exists blue_ad_tasks_notion_identity_idx
  on public.blue_ad_tasks (organization_id, notion_page_id);

create table if not exists public.blue_ad_task_sources (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  notion_database_id text not null,
  database_url text not null,
  database_title text,
  created_by uuid references public.profiles(id) on delete set null,
  last_synced_at timestamptz,
  sync_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, notion_database_id)
);

drop trigger if exists blue_ad_task_sources_updated_at on public.blue_ad_task_sources;
create trigger blue_ad_task_sources_updated_at
  before update on public.blue_ad_task_sources
  for each row execute procedure public.set_updated_at();

alter table public.blue_ad_task_sources enable row level security;
drop policy if exists "blue_ad_task_sources: members read organization sources" on public.blue_ad_task_sources;
create policy "blue_ad_task_sources: members read organization sources"
  on public.blue_ad_task_sources for select
  using (organization_id in (select public.user_org_ids()));
drop policy if exists "blue_ad_task_sources: members manage organization sources" on public.blue_ad_task_sources;
create policy "blue_ad_task_sources: members manage organization sources"
  on public.blue_ad_task_sources for all
  using (organization_id in (select public.user_org_ids()))
  with check (organization_id in (select public.user_org_ids()));

grant select, insert, update, delete on public.blue_ad_task_sources to authenticated;
