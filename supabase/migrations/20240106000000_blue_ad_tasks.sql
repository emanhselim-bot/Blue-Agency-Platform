-- Blue Ad Tasks: organization-wide task tracking for the dashboard hub.
-- Client/member labels are snapshots so existing tasks remain readable if a
-- client or team member is later archived or renamed.

create table if not exists public.blue_ad_tasks (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 180),
  description text,
  client_id uuid,
  client_name text,
  assignee_member_id uuid,
  assignee_name text,
  assignee_email text,
  due_date date,
  category text not null default 'Media Buying',
  priority text not null default 'medium'
    check (priority in ('low', 'medium', 'high', 'urgent')),
  status text not null default 'todo'
    check (status in ('todo', 'in_progress', 'review', 'done')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists blue_ad_tasks_org_due_idx
  on public.blue_ad_tasks (organization_id, due_date, status);
create index if not exists blue_ad_tasks_org_assignee_idx
  on public.blue_ad_tasks (organization_id, assignee_member_id, status);

drop trigger if exists blue_ad_tasks_updated_at on public.blue_ad_tasks;
create trigger blue_ad_tasks_updated_at
  before update on public.blue_ad_tasks
  for each row execute procedure public.set_updated_at();

alter table public.blue_ad_tasks enable row level security;

drop policy if exists "blue_ad_tasks: members read organization tasks" on public.blue_ad_tasks;
create policy "blue_ad_tasks: members read organization tasks"
  on public.blue_ad_tasks for select
  using (organization_id in (select public.user_org_ids()));

drop policy if exists "blue_ad_tasks: members create organization tasks" on public.blue_ad_tasks;
create policy "blue_ad_tasks: members create organization tasks"
  on public.blue_ad_tasks for insert
  with check (
    organization_id in (select public.user_org_ids())
    and created_by = auth.uid()
  );

drop policy if exists "blue_ad_tasks: members update organization tasks" on public.blue_ad_tasks;
create policy "blue_ad_tasks: members update organization tasks"
  on public.blue_ad_tasks for update
  using (organization_id in (select public.user_org_ids()))
  with check (organization_id in (select public.user_org_ids()));

drop policy if exists "blue_ad_tasks: members delete organization tasks" on public.blue_ad_tasks;
create policy "blue_ad_tasks: members delete organization tasks"
  on public.blue_ad_tasks for delete
  using (organization_id in (select public.user_org_ids()));

grant select, insert, update, delete on public.blue_ad_tasks to authenticated;
