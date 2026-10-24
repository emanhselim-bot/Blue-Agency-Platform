-- The client-facing shape of the media buying dashboard.
--
-- user_layouts is keyed on the user, which is right for "how Selim arranged
-- his own screen" and wrong for this: what a client sees must not depend on
-- which team member last opened the page. So this is keyed on the
-- organisation, with a scope left open for per-client overrides later
-- ('default' is the only scope today).
create table if not exists public.client_view_layouts (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  scope           text not null default 'default',
  layout          jsonb,
  customizations  jsonb not null default '{}'::jsonb,
  updated_by      uuid,
  updated_at      timestamptz not null default now(),
  primary key (organization_id, scope)
);

alter table public.client_view_layouts enable row level security;

-- Any accepted member may read it: the preview is part of the dashboard they
-- already have. Only an owner may change what clients see.
drop policy if exists cvl_read on public.client_view_layouts;
create policy cvl_read on public.client_view_layouts
  for select to authenticated
  using (exists (
    select 1 from public.organization_members m
    where m.organization_id = client_view_layouts.organization_id
      and m.user_id = auth.uid()
      and m.accepted_at is not null));

drop policy if exists cvl_write on public.client_view_layouts;
create policy cvl_write on public.client_view_layouts
  for all to authenticated
  using (exists (
    select 1 from public.organization_members m
    where m.organization_id = client_view_layouts.organization_id
      and m.user_id = auth.uid()
      and m.accepted_at is not null
      and m.role = 'owner'))
  with check (exists (
    select 1 from public.organization_members m
    where m.organization_id = client_view_layouts.organization_id
      and m.user_id = auth.uid()
      and m.accepted_at is not null
      and m.role = 'owner'));
