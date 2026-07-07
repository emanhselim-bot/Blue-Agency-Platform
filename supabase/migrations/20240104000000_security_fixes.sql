-- ══════════════════════════════════════════════════════════════════
-- Migration: Critical Security Fixes
-- Apply to any existing database that was created from the previous schema.
-- Safe to run multiple times (all statements are idempotent).
--
-- Covers four issues from the production architecture review:
--   Fix 1 — Token column exposure via RLS + SQL grants
--   Fix 2 — Invitation enumeration via USING (true) policy
-- (Fixes 3 & 4 are TypeScript changes in shopify-oauth.ts — no SQL needed.)
-- ══════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────
-- FIX 1: Prevent authenticated users from reading plaintext tokens
--
-- Problem: shopify_stores.access_token and
--          meta_business_managers.access_token were readable by any
--          authenticated org member because Supabase grants table-level
--          SELECT to the authenticated role by default, and RLS only
--          filters rows — not columns.
--
-- Solution:
--   a) Revoke table-level SELECT from authenticated and anon.
--   b) Recreate the safe views with security_invoker = false (runs as
--      view owner / postgres superuser) so the view can still read the
--      base tables.
--   c) Add a WHERE clause to each view that replicates the org-membership
--      filter that RLS previously provided, using user_org_ids() which
--      reads auth.uid() from the current request JWT.
--   d) Grant SELECT only on the safe views.
--
-- Effect: SELECT access_token FROM shopify_stores now returns
--   "permission denied for table shopify_stores" for authenticated users.
--   SELECT * FROM shopify_stores_safe returns only safe columns, filtered
--   to the caller's orgs. Edge Functions (service role) are unaffected.
-- ──────────────────────────────────────────────────────────────────

-- Step 1a: Revoke direct table access
revoke select on public.shopify_stores         from authenticated, anon;
revoke select on public.meta_business_managers from authenticated, anon;

-- Step 1b + 1c: Recreate safe views with SECURITY DEFINER + org filter
create or replace view public.shopify_stores_safe
  with (security_invoker = false) as
  select
    id, organization_id, shop_domain, shop_name, shop_id,
    currency, timezone, plan_name, connected_by, status,
    is_active, connected_at, last_used_at, updated_at
  from public.shopify_stores
  where organization_id in (select public.user_org_ids());

create or replace view public.meta_business_managers_safe
  with (security_invoker = false) as
  select
    id, organization_id, business_id, business_name,
    scopes, connected_by, status, last_verified_at,
    connected_at, updated_at
  from public.meta_business_managers
  where organization_id in (select public.user_org_ids());

-- Step 1d: Grant SELECT on safe views
grant select on public.shopify_stores_safe         to authenticated, anon;
grant select on public.meta_business_managers_safe to authenticated, anon;

-- ──────────────────────────────────────────────────────────────────
-- FIX 2: Remove world-readable invitation policy
--
-- Problem: "invitations: readable by token" used USING (true), which
--   allowed any authenticated user to SELECT all invitation rows from
--   any organization — leaking email addresses, org IDs, and roles.
--
-- Solution: Drop the policy. Invitation token validation is now
--   handled exclusively by the invite-lookup Edge Function, which
--   uses the service role to look up a single row by token and returns
--   only {valid, role, org_name, expires_at} — never email or org_id.
--
-- Effect: Authenticated users can no longer enumerate invitations.
--   Org admins retain full management access via the existing
--   "invitations: admins can manage" policy (FOR ALL with
--   has_permission(organization_id, 'manage_members')).
-- ──────────────────────────────────────────────────────────────────

drop policy if exists "invitations: readable by token" on public.invitations;

-- ══════════════════════════════════════════════════════════════════
-- Verification queries — run these after applying the migration
-- to confirm each fix is in effect.
-- ══════════════════════════════════════════════════════════════════

-- Fix 1 verification:
-- As an authenticated user, the following should return:
--   ERROR: permission denied for table shopify_stores
--
--   SELECT access_token FROM public.shopify_stores LIMIT 1;
--
-- And this should return columns WITHOUT access_token:
--
--   SELECT * FROM public.shopify_stores_safe LIMIT 1;

-- Fix 2 verification:
-- The following query should return 0 rows (policy no longer exists):
--
--   SELECT policyname FROM pg_policies
--   WHERE tablename = 'invitations'
--     AND policyname = 'invitations: readable by token';
