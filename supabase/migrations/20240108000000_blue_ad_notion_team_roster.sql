-- Keep Notion team directory entries available as task assignees even when
-- they do not yet have an account in the dashboard's cp_members directory.
create table if not exists public.blue_ad_task_assignees (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  notion_page_id text not null,
  notion_person_key text not null,
  full_name text not null,
  email text,
  department text,
  updated_at timestamptz not null default now(),
  unique (organization_id, notion_person_key)
);

create index if not exists blue_ad_task_assignees_org_name_idx
  on public.blue_ad_task_assignees (organization_id, full_name);

alter table public.blue_ad_task_assignees enable row level security;

drop policy if exists "blue_ad_task_assignees: members read organization roster"
  on public.blue_ad_task_assignees;
create policy "blue_ad_task_assignees: members read organization roster"
  on public.blue_ad_task_assignees for select
  using (organization_id in (select public.user_org_ids()));

grant select on public.blue_ad_task_assignees to authenticated;
