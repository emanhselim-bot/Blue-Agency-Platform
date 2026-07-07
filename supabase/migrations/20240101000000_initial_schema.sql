-- ══════════════════════════════════════════════════════════════════
-- Blue Agency · SaaS Dashboard — Database Schema
-- Run this in: Supabase → SQL Editor → New query → Run
--
-- Architecture:
--   Organizations own all data. Users access data only through org
--   membership. Row Level Security is the enforcement layer — the
--   application cannot bypass it even if it tries.
--
-- Key design decisions:
--   • Access tokens (Shopify, Meta) are NEVER in safe views or RLS
--     select policies — only Edge Functions read them via service role.
--   • has_permission() is a stable helper used in every policy that
--     needs role-based access. It reads from role_permissions, so
--     permissions can be changed without redeploying RLS policies.
--   • audit_log is append-only from the application's perspective;
--     writes go through Edge Functions using the service role key.
-- ══════════════════════════════════════════════════════════════════

-- ── Extensions ──────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";   -- for gen_random_bytes() in token generation

-- ══════════════════════════════════════════════════════════════════
-- ENUMS
-- ══════════════════════════════════════════════════════════════════

-- Role hierarchy: owner > admin > analyst > viewer
create type member_role as enum ('owner', 'admin', 'analyst', 'viewer');

-- Subscription tiers
create type plan_tier as enum ('free', 'starter', 'pro', 'enterprise');

-- Billing state
create type subscription_status as enum (
  'active', 'trialing', 'past_due', 'canceled', 'paused'
);

-- Integration connection state
create type connection_status as enum (
  'active',          -- connected and working
  'expired',         -- token needs refresh
  'disconnected',    -- user manually disconnected
  'error'            -- last API call failed
);

-- API token scope
create type token_scope as enum ('read', 'write', 'admin');

-- ══════════════════════════════════════════════════════════════════
-- CORE IDENTITY
-- ══════════════════════════════════════════════════════════════════

-- Organizations (companies / agencies)
create table public.organizations (
  id            uuid        primary key default uuid_generate_v4(),
  name          text        not null,
  slug          text        not null unique,    -- URL-safe, e.g. "blue-agency"
  logo_url      text,
  website       text,
  industry      text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- User profiles (one per auth.users row)
-- Denormalizes email for fast lookups without joining auth.users.
create table public.profiles (
  id            uuid        primary key references auth.users(id) on delete cascade,
  email         text        not null unique,
  full_name     text,
  avatar_url    text,
  phone         text,
  timezone      text        not null default 'UTC',
  locale        text        not null default 'en',
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ══════════════════════════════════════════════════════════════════
-- MEMBERSHIP & PERMISSIONS
-- ══════════════════════════════════════════════════════════════════

-- Team members: many-to-many between users and organizations.
-- accepted_at = null means the invitation is pending.
create table public.organization_members (
  id              uuid        primary key default uuid_generate_v4(),
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  user_id         uuid        not null references public.profiles(id) on delete cascade,
  role            member_role not null default 'analyst',
  invited_by      uuid        references public.profiles(id) on delete set null,
  invited_at      timestamptz not null default now(),
  accepted_at     timestamptz,           -- null = pending invitation
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, user_id)
);

-- Pending invitations for users who haven't signed up yet.
-- On signup, the Edge Function matches by email and creates
-- the organization_members row with accepted_at = now().
create table public.invitations (
  id              uuid        primary key default uuid_generate_v4(),
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  email           text        not null,
  role            member_role not null default 'analyst',
  token           text        not null unique default encode(gen_random_bytes(32), 'hex'),
  invited_by      uuid        not null references public.profiles(id) on delete cascade,
  expires_at      timestamptz not null default (now() + interval '7 days'),
  accepted_at     timestamptz,
  created_at      timestamptz not null default now(),
  unique (organization_id, email)
);

-- Declarative permission map: role → set of named permissions.
-- Changing permissions here propagates instantly to all RLS policies
-- without redeploying anything.
create table public.role_permissions (
  role        member_role not null,
  permission  text        not null,
  primary key (role, permission)
);

-- Default permission seed
-- manage_org:          rename org, delete org, transfer ownership
-- manage_members:      invite/remove/change-role team members
-- manage_billing:      change subscription plan, update payment method
-- manage_integrations: connect/disconnect Shopify stores & Meta accounts
-- manage_settings:     change org-level settings, dashboard defaults
-- view_analytics:      load dashboard data
insert into public.role_permissions (role, permission) values
  ('owner',   'manage_org'),
  ('owner',   'manage_members'),
  ('owner',   'manage_billing'),
  ('owner',   'manage_integrations'),
  ('owner',   'manage_settings'),
  ('owner',   'view_analytics'),
  ('admin',   'manage_members'),
  ('admin',   'manage_integrations'),
  ('admin',   'manage_settings'),
  ('admin',   'view_analytics'),
  ('analyst', 'view_analytics'),
  ('viewer',  'view_analytics');

-- ══════════════════════════════════════════════════════════════════
-- SUBSCRIPTION PLANS
-- ══════════════════════════════════════════════════════════════════

create table public.subscription_plans (
  id                    plan_tier   primary key,
  name                  text        not null,
  description           text,
  price_monthly_usd     numeric(10,2),      -- null = custom pricing
  price_yearly_usd      numeric(10,2),
  max_users             int,                -- null = unlimited
  max_shopify_stores    int,
  max_meta_accounts     int,
  max_api_tokens        int,
  features              jsonb       not null default '[]',
  is_public             boolean     not null default true,
  created_at            timestamptz not null default now()
);

insert into public.subscription_plans
  (id, name, description, price_monthly_usd, price_yearly_usd,
   max_users, max_shopify_stores, max_meta_accounts, max_api_tokens, features)
values
  ('free',
   'Free', 'Try the platform',
   0, 0,
   1, 1, 3, 1,
   '["1 user","1 Shopify store","3 Meta accounts","30-day data history","Community support"]'),

  ('starter',
   'Starter', 'Small teams',
   49, 470,
   3, 3, 10, 3,
   '["3 users","3 Shopify stores","10 Meta accounts","12-month history","Email support","Custom date ranges"]'),

  ('pro',
   'Pro', 'Growing agencies',
   149, 1430,
   10, null, null, 10,
   '["10 users","Unlimited stores & accounts","Full data history","API access","Priority support","White-label ready"]'),

  ('enterprise',
   'Enterprise', 'Unlimited scale',
   null, null,
   null, null, null, null,
   '["Unlimited everything","Custom integrations","99.9% SLA","Dedicated account manager","SSO / SAML","On-premise option"]');

-- One subscription row per organization (created automatically via trigger)
create table public.organization_subscriptions (
  id                     uuid                primary key default uuid_generate_v4(),
  organization_id        uuid                not null unique
                                             references public.organizations(id) on delete cascade,
  plan_id                plan_tier           not null default 'free',
  status                 subscription_status not null default 'active',
  stripe_customer_id     text,
  stripe_subscription_id text,
  trial_ends_at          timestamptz,
  current_period_start   timestamptz,
  current_period_end     timestamptz,
  canceled_at            timestamptz,
  created_at             timestamptz         not null default now(),
  updated_at             timestamptz         not null default now()
);

-- ══════════════════════════════════════════════════════════════════
-- META INTEGRATIONS
-- ══════════════════════════════════════════════════════════════════

-- Meta Business Manager: one row per Facebook Business connection.
-- The long-lived access token lives here — NOT on individual ad accounts.
-- Multiple ad accounts share one token via business_manager_id.
create table public.meta_business_managers (
  id               uuid              primary key default uuid_generate_v4(),
  organization_id  uuid              not null references public.organizations(id) on delete cascade,
  business_id      text              not null,   -- Meta Business Manager ID
  business_name    text,
  access_token     text              not null,   -- long-lived user/system token (60 days)
  token_expires_at timestamptz,
  scopes           text[],                       -- OAuth scopes granted
  connected_by     uuid              references public.profiles(id) on delete set null,
  status           connection_status not null default 'active',
  last_verified_at timestamptz,
  connected_at     timestamptz       not null default now(),
  updated_at       timestamptz       not null default now(),
  unique (organization_id, business_id)
);

-- Individual Meta Ad Accounts (belong to a Business Manager)
create table public.meta_ad_accounts (
  id                  uuid              primary key default uuid_generate_v4(),
  organization_id     uuid              not null references public.organizations(id) on delete cascade,
  business_manager_id uuid              references public.meta_business_managers(id) on delete set null,
  meta_account_id     text              not null,   -- numeric ID (without "act_" prefix)
  account_name        text,
  currency            text              not null default 'USD',
  timezone            text,
  account_status      int,              -- Meta's account_status value (1 = active)
  shopify_store_id    uuid,             -- FK defined after shopify_stores; for ROAS linking
  is_active           boolean           not null default true,
  connected_at        timestamptz       not null default now(),
  updated_at          timestamptz       not null default now(),
  unique (organization_id, meta_account_id)
);

-- ══════════════════════════════════════════════════════════════════
-- SHOPIFY INTEGRATIONS
-- ══════════════════════════════════════════════════════════════════

create table public.shopify_stores (
  id              uuid              primary key default uuid_generate_v4(),
  organization_id uuid              not null references public.organizations(id) on delete cascade,
  shop_domain     text              not null,   -- e.g. brand.myshopify.com
  shop_name       text,
  shop_id         text,             -- Shopify's internal numeric shop ID
  access_token    text              not null,   -- permanent offline access token
  scopes          text,             -- comma-separated OAuth scopes
  currency        text,
  timezone        text,
  plan_name       text,             -- Shopify plan (basic, shopify, advanced, plus, etc.)
  connected_by    uuid              references public.profiles(id) on delete set null,
  status          connection_status not null default 'active',
  is_active       boolean           not null default true,
  connected_at    timestamptz       not null default now(),
  last_used_at    timestamptz,
  updated_at      timestamptz       not null default now(),
  unique (organization_id, shop_domain)
);

-- Now that shopify_stores exists, add the FK on meta_ad_accounts
alter table public.meta_ad_accounts
  add constraint fk_meta_shopify_link
  foreign key (shopify_store_id)
  references public.shopify_stores(id)
  on delete set null;

-- ══════════════════════════════════════════════════════════════════
-- API TOKENS
-- Tokens are generated once and shown to the user once.
-- Only the SHA-256 hash is stored; the plaintext is never persisted.
-- Token format: blue_{prefix}_{secret}  e.g. blue_k7x2m_<64-char-hex>
-- ══════════════════════════════════════════════════════════════════

create table public.api_tokens (
  id              uuid        primary key default uuid_generate_v4(),
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  user_id         uuid        not null references public.profiles(id) on delete cascade,
  name            text        not null,          -- human label, e.g. "CI/CD pipeline"
  token_hash      text        not null unique,   -- sha256(full_token)
  token_prefix    text        not null,          -- first 12 chars shown in UI for identification
  scope           token_scope not null default 'read',
  last_used_at    timestamptz,
  expires_at      timestamptz,                   -- null = never expires
  revoked_at      timestamptz,                   -- null = still valid
  created_at      timestamptz not null default now()
);

-- ══════════════════════════════════════════════════════════════════
-- DASHBOARD SETTINGS
-- Per-user, per-organization preferences.
-- Saved after each interaction so the user's state is restored on reload.
-- ══════════════════════════════════════════════════════════════════

create table public.dashboard_settings (
  id                    uuid        primary key default uuid_generate_v4(),
  user_id               uuid        not null references public.profiles(id) on delete cascade,
  organization_id       uuid        not null references public.organizations(id) on delete cascade,
  -- Last-used state (restored on next login)
  default_account_id    uuid        references public.meta_ad_accounts(id) on delete set null,
  default_period        text        not null default 'today',
  custom_from           date,
  custom_to             date,
  -- UI preferences
  auto_refresh_minutes  int         not null default 30,
  show_shopify_kpis     boolean     not null default true,
  theme                 text        not null default 'light',
  -- Notifications
  notifications_enabled boolean     not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (user_id, organization_id)
);

-- ══════════════════════════════════════════════════════════════════
-- ORGANIZATION SETTINGS
-- Org-level configuration managed by admins/owners.
-- ══════════════════════════════════════════════════════════════════

create table public.organization_settings (
  organization_id       uuid      primary key
                                  references public.organizations(id) on delete cascade,
  default_currency      text      not null default 'USD',
  default_timezone      text      not null default 'UTC',
  -- Restrict sign-up to specific email domains (e.g. ['yourcompany.com'])
  allowed_email_domains text[],
  require_2fa           boolean   not null default false,
  -- Reporting integrations
  slack_webhook_url     text,
  report_recipients     text[],
  -- White-label branding
  custom_logo_url       text,
  primary_color         text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ══════════════════════════════════════════════════════════════════
-- AUDIT LOG
-- Immutable record of security-relevant and billing-relevant events.
-- Written by Edge Functions using the service role key.
-- Application users can read their own org's log (filtered by RLS).
-- ══════════════════════════════════════════════════════════════════

create table public.audit_log (
  id              uuid        primary key default uuid_generate_v4(),
  organization_id uuid        references public.organizations(id) on delete set null,
  user_id         uuid        references public.profiles(id) on delete set null,
  -- What happened
  action          text        not null,    -- 'member.invited', 'store.connected', 'token.created'…
  resource_type   text,                   -- 'shopify_store', 'meta_ad_account', 'api_token'…
  resource_id     uuid,
  -- Extra context
  metadata        jsonb,
  ip_address      inet,
  user_agent      text,
  created_at      timestamptz not null default now()
);

-- ══════════════════════════════════════════════════════════════════
-- TRIGGERS
-- ══════════════════════════════════════════════════════════════════

-- updated_at auto-stamp
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger t_organizations_upd      before update on public.organizations            for each row execute procedure public.set_updated_at();
create trigger t_profiles_upd           before update on public.profiles                 for each row execute procedure public.set_updated_at();
create trigger t_org_members_upd        before update on public.organization_members      for each row execute procedure public.set_updated_at();
create trigger t_subscriptions_upd      before update on public.organization_subscriptions for each row execute procedure public.set_updated_at();
create trigger t_meta_bmgr_upd          before update on public.meta_business_managers    for each row execute procedure public.set_updated_at();
create trigger t_meta_accounts_upd      before update on public.meta_ad_accounts          for each row execute procedure public.set_updated_at();
create trigger t_shopify_upd            before update on public.shopify_stores             for each row execute procedure public.set_updated_at();
create trigger t_dash_settings_upd      before update on public.dashboard_settings         for each row execute procedure public.set_updated_at();
create trigger t_org_settings_upd       before update on public.organization_settings      for each row execute procedure public.set_updated_at();

-- Auto-create profile on new user signup.
-- Works for both email/password and OAuth (Google, etc.) signups —
-- avatar_url and full_name come from raw_user_meta_data set by the provider.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'name'
    ),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Auto-create free subscription + org settings when an org is created.
create or replace function public.handle_new_organization()
returns trigger language plpgsql security definer as $$
begin
  insert into public.organization_subscriptions (organization_id, plan_id, status)
  values (new.id, 'free', 'active')
  on conflict do nothing;

  insert into public.organization_settings (organization_id)
  values (new.id)
  on conflict do nothing;

  return new;
end;
$$;

create or replace trigger on_organization_created
  after insert on public.organizations
  for each row execute procedure public.handle_new_organization();

-- ══════════════════════════════════════════════════════════════════
-- HELPER FUNCTIONS
-- Used by RLS policies and Edge Functions.
-- security definer = runs as the function owner (postgres superuser),
-- which allows reading tables the calling user has no direct access to.
-- ══════════════════════════════════════════════════════════════════

-- All org IDs where the current user is an accepted member.
create or replace function public.user_org_ids()
returns setof uuid language sql security definer stable as $$
  select organization_id
  from public.organization_members
  where user_id     = auth.uid()
    and accepted_at is not null;
$$;

-- The current user's role in a given org (null if not a member).
create or replace function public.user_role(
  _org_id uuid
)
returns member_role language sql security definer stable as $$
  select role
  from public.organization_members
  where organization_id = _org_id
    and user_id         = auth.uid()
    and accepted_at     is not null
  limit 1;
$$;

-- True if the current user has a specific named permission in an org.
-- This is the single gate used across all RLS policies — change permissions
-- in the role_permissions table, and all policies update automatically.
create or replace function public.has_permission(
  _org_id     uuid,
  _permission text
)
returns boolean language sql security definer stable as $$
  select exists (
    select 1
    from public.organization_members m
    join public.role_permissions     rp on rp.role = m.role
    where m.organization_id = _org_id
      and m.user_id         = auth.uid()
      and m.accepted_at     is not null
      and rp.permission     = _permission
  );
$$;

-- The active plan tier for an org (returns null if no active subscription).
create or replace function public.org_plan(
  _org_id uuid
)
returns plan_tier language sql security definer stable as $$
  select plan_id
  from public.organization_subscriptions
  where organization_id = _org_id
    and status in ('active', 'trialing')
  limit 1;
$$;

-- ══════════════════════════════════════════════════════════════════
-- SAFE VIEWS
-- Strip access_token columns so the frontend can query these views
-- directly via the Supabase client without ever seeing raw tokens.
-- Actual tokens are readable only by Edge Functions via service role.
--
-- SECURITY (Critical fix #1):
-- shopify_stores and meta_business_managers have SELECT revoked from
-- authenticated/anon below, so client code can never reach access_token.
-- The two views that wrap those tables use security_invoker = false
-- (run as view owner = postgres superuser) so they can still read the
-- base tables. The WHERE clause replicates the row-level filter by
-- calling user_org_ids(), which reads auth.uid() from the current
-- request JWT — callers still only see their own org's rows.
-- ══════════════════════════════════════════════════════════════════

-- security_invoker = false → runs as view owner (postgres), bypassing
-- the revoke below, while the WHERE clause enforces org membership.
create or replace view public.shopify_stores_safe
  with (security_invoker = false) as
  select
    id, organization_id, shop_domain, shop_name, shop_id,
    currency, timezone, plan_name, connected_by, status,
    is_active, connected_at, last_used_at, updated_at
  from public.shopify_stores
  where organization_id in (select public.user_org_ids());

-- meta_ad_accounts has no plaintext token; standard security_invoker
-- (default) is fine. RLS on the base table still applies.
create or replace view public.meta_ad_accounts_safe as
  select
    id, organization_id, business_manager_id, meta_account_id,
    account_name, currency, timezone, account_status,
    shopify_store_id, is_active, connected_at, updated_at
  from public.meta_ad_accounts;

-- Same security_invoker = false pattern as shopify_stores_safe.
create or replace view public.meta_business_managers_safe
  with (security_invoker = false) as
  select
    id, organization_id, business_id, business_name,
    scopes, connected_by, status, last_verified_at,
    connected_at, updated_at
  from public.meta_business_managers
  where organization_id in (select public.user_org_ids());

-- ══════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- Every table is locked by default. Policies open up exactly the
-- access each role needs — nothing more.
-- ══════════════════════════════════════════════════════════════════

alter table public.organizations              enable row level security;
alter table public.profiles                   enable row level security;
alter table public.organization_members       enable row level security;
alter table public.invitations                enable row level security;
alter table public.role_permissions           enable row level security;
alter table public.subscription_plans         enable row level security;
alter table public.organization_subscriptions enable row level security;
alter table public.meta_business_managers     enable row level security;
alter table public.meta_ad_accounts           enable row level security;
alter table public.shopify_stores             enable row level security;
alter table public.api_tokens                 enable row level security;
alter table public.dashboard_settings         enable row level security;
alter table public.organization_settings      enable row level security;
alter table public.audit_log                  enable row level security;

-- ── profiles ──────────────────────────────────────────────────────
create policy "profiles: own row"
  on public.profiles for all
  using (id = auth.uid());

-- See basic info of teammates in shared orgs (for member lists)
create policy "profiles: see teammates"
  on public.profiles for select
  using (
    id in (
      select user_id from public.organization_members
      where organization_id in (select public.user_org_ids())
    )
  );

-- ── organizations ─────────────────────────────────────────────────
create policy "organizations: members can read"
  on public.organizations for select
  using (id in (select public.user_org_ids()));

create policy "organizations: owners can update"
  on public.organizations for update
  using (public.has_permission(id, 'manage_org'));

-- Any authenticated user can create a new org (they become owner via app logic)
create policy "organizations: any user can create"
  on public.organizations for insert
  with check (auth.uid() is not null);

-- ── organization_members ──────────────────────────────────────────
create policy "members: read own orgs"
  on public.organization_members for select
  using (organization_id in (select public.user_org_ids()));

create policy "members: admins can invite"
  on public.organization_members for insert
  with check (public.has_permission(organization_id, 'manage_members'));

create policy "members: admins can change role"
  on public.organization_members for update
  using (public.has_permission(organization_id, 'manage_members'));

create policy "members: admins can remove"
  on public.organization_members for delete
  using (public.has_permission(organization_id, 'manage_members'));

-- Users can accept their own pending invitation
create policy "members: accept own invite"
  on public.organization_members for update
  using (user_id = auth.uid() and accepted_at is null);

-- ── invitations ───────────────────────────────────────────────────
create policy "invitations: admins can manage"
  on public.invitations for all
  using (public.has_permission(organization_id, 'manage_members'));

-- Token-based invite lookup is handled by the invite-lookup Edge Function
-- (supabase/functions/invite-lookup/index.ts), which uses the service role
-- to validate a token without exposing any other invitation rows.
-- There is intentionally no client-accessible SELECT policy for unauthenticated
-- token lookup — that path goes through the Edge Function only.

-- ── role_permissions ──────────────────────────────────────────────
-- Read-only for all signed-in users; written only via DB migrations
create policy "role_permissions: authenticated read"
  on public.role_permissions for select
  using (auth.uid() is not null);

-- ── subscription_plans ────────────────────────────────────────────
create policy "plans: anyone can read public plans"
  on public.subscription_plans for select
  using (is_public = true);

-- ── organization_subscriptions ────────────────────────────────────
create policy "subscriptions: members can read"
  on public.organization_subscriptions for select
  using (organization_id in (select public.user_org_ids()));

create policy "subscriptions: owners can update"
  on public.organization_subscriptions for update
  using (public.has_permission(organization_id, 'manage_billing'));

-- ── meta_business_managers ────────────────────────────────────────
-- The access_token column is present but the Supabase anon key cannot
-- read it — the anon key only has rights to the safe view.
-- Service role (used in Edge Functions) bypasses RLS entirely.
create policy "bmgr: members can read"
  on public.meta_business_managers for select
  using (organization_id in (select public.user_org_ids()));

create policy "bmgr: admins can connect"
  on public.meta_business_managers for insert
  with check (public.has_permission(organization_id, 'manage_integrations'));

create policy "bmgr: admins can update"
  on public.meta_business_managers for update
  using (public.has_permission(organization_id, 'manage_integrations'));

create policy "bmgr: admins can disconnect"
  on public.meta_business_managers for delete
  using (public.has_permission(organization_id, 'manage_integrations'));

-- ── meta_ad_accounts ──────────────────────────────────────────────
create policy "meta_accounts: members can read"
  on public.meta_ad_accounts for select
  using (organization_id in (select public.user_org_ids()));

create policy "meta_accounts: admins can write"
  on public.meta_ad_accounts for all
  using (public.has_permission(organization_id, 'manage_integrations'));

-- ── shopify_stores ────────────────────────────────────────────────
create policy "shopify: members can read"
  on public.shopify_stores for select
  using (organization_id in (select public.user_org_ids()));

create policy "shopify: admins can write"
  on public.shopify_stores for all
  using (public.has_permission(organization_id, 'manage_integrations'));

-- ── api_tokens ────────────────────────────────────────────────────
create policy "tokens: own tokens"
  on public.api_tokens for select
  using (user_id = auth.uid());

create policy "tokens: org admins see all"
  on public.api_tokens for select
  using (public.has_permission(organization_id, 'manage_settings'));

create policy "tokens: users can create"
  on public.api_tokens for insert
  with check (
    user_id = auth.uid()
    and organization_id in (select public.user_org_ids())
  );

-- Users can revoke their own tokens; admins can revoke any in the org
create policy "tokens: users can revoke own"
  on public.api_tokens for update
  using (user_id = auth.uid());

create policy "tokens: admins can revoke any"
  on public.api_tokens for update
  using (public.has_permission(organization_id, 'manage_settings'));

-- ── dashboard_settings ────────────────────────────────────────────
-- Strictly per-user — no one else can read or modify your preferences
create policy "dash_settings: own row only"
  on public.dashboard_settings for all
  using (user_id = auth.uid());

-- ── organization_settings ─────────────────────────────────────────
create policy "org_settings: members can read"
  on public.organization_settings for select
  using (organization_id in (select public.user_org_ids()));

create policy "org_settings: admins can write"
  on public.organization_settings for all
  using (public.has_permission(organization_id, 'manage_settings'));

-- ── audit_log ─────────────────────────────────────────────────────
-- Members can read their org's audit log; inserts are service-role only
create policy "audit: members can read"
  on public.audit_log for select
  using (organization_id in (select public.user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- INDEXES
-- ══════════════════════════════════════════════════════════════════

create index idx_org_members_org      on public.organization_members(organization_id);
create index idx_org_members_user     on public.organization_members(user_id);
create index idx_org_members_accepted on public.organization_members(accepted_at)
  where accepted_at is not null;

create index idx_meta_accounts_org    on public.meta_ad_accounts(organization_id);
create index idx_meta_accounts_bmgr   on public.meta_ad_accounts(business_manager_id);
create index idx_meta_accounts_store  on public.meta_ad_accounts(shopify_store_id);

create index idx_shopify_org          on public.shopify_stores(organization_id);

create index idx_api_tokens_org       on public.api_tokens(organization_id);
create index idx_api_tokens_user      on public.api_tokens(user_id);
create index idx_api_tokens_hash      on public.api_tokens(token_hash);

create index idx_dash_settings        on public.dashboard_settings(user_id, organization_id);

create index idx_audit_org            on public.audit_log(organization_id, created_at desc);
create index idx_audit_user           on public.audit_log(user_id, created_at desc);

create index idx_invitations_token    on public.invitations(token);
create index idx_invitations_email    on public.invitations(email);

-- ══════════════════════════════════════════════════════════════════
-- CRITICAL SECURITY: Revoke direct access to token-bearing tables.
--
-- By default Supabase grants ALL PRIVILEGES on public tables to
-- authenticated and anon. RLS controls which rows they see, but not
-- which columns. An org member could SELECT access_token directly.
--
-- Fix: REVOKE SELECT on the two tables that store plaintext tokens.
-- Grant SELECT only on the safe views, which (a) exclude access_token
-- and (b) filter rows via user_org_ids(). The service_role key used
-- by Edge Functions bypasses both RLS and these grants, so nothing
-- breaks server-side.
-- ══════════════════════════════════════════════════════════════════

revoke select on public.shopify_stores         from authenticated, anon;
revoke select on public.meta_business_managers from authenticated, anon;

grant  select on public.shopify_stores_safe         to authenticated, anon;
grant  select on public.meta_business_managers_safe to authenticated, anon;

-- ══════════════════════════════════════════════════════════════════
-- BOOTSTRAP RPC: create_organization
--
-- New users have no org memberships, so they can't satisfy any RLS
-- policy that checks has_permission() or user_org_ids(). A direct
-- INSERT to organizations + organization_members would be blocked.
--
-- Solution: SECURITY DEFINER function that runs as the DB owner and
-- atomically creates the org + owner membership in one call.
-- The calling user is identified via auth.uid() inside the function.
--
-- Slug generation: lowercase the name, collapse non-alphanumeric runs
-- to hyphens, then append -N until the slug is unique.
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

  -- Add calling user as owner (accepted immediately)
  insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (new_org_id, auth.uid(), 'owner', now());

  return new_org_id;
end;
$$;

grant execute on function public.create_organization(text) to authenticated;
