-- ══════════════════════════════════════════════════════════════════
-- Migration: Member Account & Agency Access Control
-- Adds per-member access restrictions so owners can limit which
-- accounts and agencies each team member can view.
-- ══════════════════════════════════════════════════════════════════

-- 1. Add access columns to organization_members
--    NULL = unrestricted (owner default)
--    jsonb array = restricted to these IDs only
alter table public.organization_members
  add column if not exists allowed_account_ids jsonb default null,
  add column if not exists allowed_agency_ids  jsonb default null;

-- 2. get_team_members — returns all members + pending invites for an org
--    Caller must be an owner of the org.
create or replace function public.get_team_members(_org_id uuid)
returns table (
  member_id           uuid,
  user_id             uuid,
  email               text,
  full_name           text,
  role                member_role,
  accepted_at         timestamptz,
  allowed_account_ids jsonb,
  allowed_agency_ids  jsonb,
  is_pending          boolean
) language sql security definer stable as $$
  -- Accepted members
  select
    m.id            as member_id,
    m.user_id,
    p.email,
    p.full_name,
    m.role,
    m.accepted_at,
    m.allowed_account_ids,
    m.allowed_agency_ids,
    false           as is_pending
  from public.organization_members m
  left join public.profiles p on p.id = m.user_id
  where m.organization_id = _org_id
    and m.accepted_at is not null
    and (
      select om2.role from public.organization_members om2
      where om2.organization_id = _org_id
        and om2.user_id = auth.uid()
        and om2.accepted_at is not null
      limit 1
    ) = 'owner'

  union all

  -- Pending invitations (no user_id yet)
  select
    i.id            as member_id,
    null            as user_id,
    i.email,
    null            as full_name,
    i.role,
    null            as accepted_at,
    null            as allowed_account_ids,
    null            as allowed_agency_ids,
    true            as is_pending
  from public.invitations i
  where i.organization_id = _org_id
    and i.accepted_at is null
    and i.expires_at > now()
    and (
      select om2.role from public.organization_members om2
      where om2.organization_id = _org_id
        and om2.user_id = auth.uid()
        and om2.accepted_at is not null
      limit 1
    ) = 'owner'

  order by is_pending asc, accepted_at desc nulls last;
$$;

-- 3. update_member_access — owner can set per-member account/agency restrictions
create or replace function public.update_member_access(
  _member_id          uuid,
  _allowed_accounts   jsonb,  -- null = unrestricted, [] = no access, [...ids] = restricted
  _allowed_agencies   jsonb   -- null = unrestricted, [] = no access, [...ids] = restricted
)
returns void language plpgsql security definer as $$
declare
  v_org_id uuid;
begin
  -- Get the org for this member record
  select organization_id into v_org_id
  from public.organization_members
  where id = _member_id;

  if v_org_id is null then
    raise exception 'Member not found';
  end if;

  -- Ensure caller is owner of that org
  if (
    select role from public.organization_members
    where organization_id = v_org_id and user_id = auth.uid() and accepted_at is not null
    limit 1
  ) != 'owner' then
    raise exception 'Only owners can update member access';
  end if;

  -- Prevent restricting the owner themselves
  if (
    select role from public.organization_members
    where id = _member_id
  ) = 'owner' then
    raise exception 'Cannot restrict owner access';
  end if;

  update public.organization_members
  set allowed_account_ids = _allowed_accounts,
      allowed_agency_ids  = _allowed_agencies
  where id = _member_id;
end;
$$;

-- 4. get_my_access — returns the current user's access restrictions for an org
create or replace function public.get_my_access(_org_id uuid)
returns table (
  role                member_role,
  allowed_account_ids jsonb,
  allowed_agency_ids  jsonb
) language sql security definer stable as $$
  select role, allowed_account_ids, allowed_agency_ids
  from public.organization_members
  where organization_id = _org_id
    and user_id = auth.uid()
    and accepted_at is not null
  limit 1;
$$;
