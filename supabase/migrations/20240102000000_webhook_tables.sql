-- ══════════════════════════════════════════════════════════════════
-- Shopify Webhooks Migration
-- Run in: Supabase → SQL Editor → New query → Run
--
-- Adds two new tables:
--   shopify_webhook_subscriptions — tracks which webhooks are registered
--                                   per store (topic + Shopify webhook ID)
--   shopify_orders                — stores order data received via webhook
--                                   (orders/create and orders/updated)
--
-- Also adds an index on shopify_stores.shop_domain for fast webhook
-- dispatch (the handler looks up stores by domain on every event).
-- ══════════════════════════════════════════════════════════════════

-- ── shopify_webhook_subscriptions ─────────────────────────────────
-- One row per (store, topic) pair. Populated by shopify-oauth.ts after
-- each successful OAuth flow. Used to:
--   • Avoid duplicate registration on store reconnect
--   • Track which webhooks we're responsible for on Shopify's end
--   • Clean up when app/uninstalled or shop/redact fires
create table if not exists public.shopify_webhook_subscriptions (
  id              uuid        primary key default uuid_generate_v4(),
  store_id        uuid        not null references public.shopify_stores(id) on delete cascade,
  organization_id uuid        not null references public.organizations(id)  on delete cascade,
  topic           text        not null,   -- e.g. 'orders/create', 'app/uninstalled'
  shopify_webhook_id text     not null,   -- Shopify's numeric webhook ID (as text)
  address         text        not null,   -- the endpoint URL we registered
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (store_id, topic)
);

create trigger t_shopify_webhook_subs_upd
  before update on public.shopify_webhook_subscriptions
  for each row execute procedure public.set_updated_at();

-- ── shopify_orders ─────────────────────────────────────────────────
-- Populated by orders/create and orders/updated webhooks.
-- email is nullable because customers/redact zeroes it out on request.
-- raw_data stores the full webhook payload for debugging/re-processing;
-- it is also nulled out during customers/redact to remove embedded PII.
create table if not exists public.shopify_orders (
  id                    uuid          primary key default uuid_generate_v4(),
  store_id              uuid          not null references public.shopify_stores(id) on delete cascade,
  organization_id       uuid          not null references public.organizations(id)  on delete cascade,
  shopify_order_id      text          not null,   -- Shopify's numeric order ID (string for safety)
  order_number          int,                       -- human-readable #1001, #1002, …
  email                 text,                      -- customer email — nullable (GDPR redact)
  financial_status      text,                      -- pending | authorized | paid | refunded | voided
  fulfillment_status    text,                      -- null | fulfilled | partial | restocked
  total_price           numeric(12,2),
  subtotal_price        numeric(12,2),
  total_tax             numeric(12,2),
  currency              text,
  line_items_count      int,
  tags                  text,                      -- comma-separated order tags
  source_name           text,                      -- web | pos | iphone | android | api
  created_at_shopify    timestamptz,               -- when Shopify created the order
  updated_at_shopify    timestamptz,               -- when Shopify last updated it
  processed_at          timestamptz,
  cancelled_at          timestamptz,               -- non-null if order was cancelled
  raw_data              jsonb,                     -- full webhook payload (nulled on GDPR redact)
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),
  unique (store_id, shopify_order_id)
);

create trigger t_shopify_orders_upd
  before update on public.shopify_orders
  for each row execute procedure public.set_updated_at();

-- ── Row Level Security ─────────────────────────────────────────────
alter table public.shopify_webhook_subscriptions enable row level security;
alter table public.shopify_orders                enable row level security;

-- Webhook subscriptions: members can read, admins can write
create policy "webhook_subs: members can read"
  on public.shopify_webhook_subscriptions for select
  using (organization_id in (select public.user_org_ids()));

create policy "webhook_subs: admins can write"
  on public.shopify_webhook_subscriptions for all
  using (public.has_permission(organization_id, 'manage_integrations'));

-- Orders: members with view_analytics can read, no browser writes
-- (all inserts/updates come from Edge Functions via service role)
create policy "orders: members can read"
  on public.shopify_orders for select
  using (
    organization_id in (select public.user_org_ids())
    and public.has_permission(organization_id, 'view_analytics')
  );

-- ── Indexes ────────────────────────────────────────────────────────
-- Fast webhook dispatch: every incoming event does findStore(shopDomain)
create index if not exists idx_shopify_stores_domain
  on public.shopify_stores(shop_domain);

-- Order lookups by store (dashboard queries, GDPR redact, shop redact)
create index if not exists idx_shopify_orders_store
  on public.shopify_orders(store_id, created_at_shopify desc);

create index if not exists idx_shopify_orders_org
  on public.shopify_orders(organization_id, created_at_shopify desc);

-- GDPR redact by email — used in customers/redact handler
create index if not exists idx_shopify_orders_email
  on public.shopify_orders(store_id, email)
  where email is not null;

-- Webhook subscription lookups
create index if not exists idx_webhook_subs_store
  on public.shopify_webhook_subscriptions(store_id);
