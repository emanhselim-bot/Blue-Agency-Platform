-- ══════════════════════════════════════════════════════════════════
-- Migration: Add create_organization SECURITY DEFINER RPC
-- Apply to any existing database that was created from the previous schema.
-- Safe to run multiple times (CREATE OR REPLACE is idempotent).
--
-- Why this is needed:
--   New users arrive with zero org memberships. Every RLS policy that
--   gates INSERT on organizations or organization_members requires the
--   caller to already be a member (has_permission / user_org_ids).
--   This is the bootstrap chicken-and-egg problem.
--
--   Solution: a SECURITY DEFINER function that runs as the DB owner
--   and atomically creates the org + owner membership. The caller is
--   identified via auth.uid() inside the function body.
-- ══════════════════════════════════════════════════════════════════

create or replace function public.create_organization(org_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_org_id uuid;
  base_slug  text;
  final_slug text;
  suffix     int := 0;
begin
  if length(trim(org_name)) = 0 then
    raise exception 'Organization name cannot be empty';
  end if;

  -- Build URL-safe slug from org name
  base_slug := lower(regexp_replace(trim(org_name), '[^a-z0-9]+', '-', 'g'));
  base_slug := trim(both '-' from base_slug);
  if length(base_slug) = 0 then base_slug := 'org'; end if;

  -- Find a unique slug
  final_slug := base_slug;
  loop
    exit when not exists (select 1 from public.organizations where slug = final_slug);
    suffix     := suffix + 1;
    final_slug := base_slug || '-' || suffix::text;
  end loop;

  -- Create the organization
  insert into public.organizations (name, slug)
  values (trim(org_name), final_slug)
  returning id into new_org_id;

  -- Add calling user as owner (accepted immediately — no invite required)
  insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (new_org_id, auth.uid(), 'owner', now());

  return new_org_id;
end;
$$;

grant execute on function public.create_organization(text) to authenticated;

-- ══════════════════════════════════════════════════════════════════
-- Verification — after applying:
--
-- SELECT prosecdef FROM pg_proc
-- JOIN pg_namespace ON pg_proc.pronamespace = pg_namespace.oid
-- WHERE nspname = 'public' AND proname = 'create_organization';
-- → should return: t  (security definer = true)
--
-- As an authenticated user (not service role):
-- SELECT public.create_organization('Test Org');
-- → should return a UUID, not a permission error.
-- ══════════════════════════════════════════════════════════════════
