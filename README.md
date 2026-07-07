# Blue Agency Platform

Multi-tenant analytics dashboard for marketing agencies. Connects Shopify stores and Meta (Facebook) ad accounts to give clients a unified view of their marketing performance.

## What's included

| Layer | Technology |
|-------|-----------|
| Frontend | Single-file HTML/JS dashboard (`dashboard.html`) |
| Backend | Supabase (PostgreSQL + Auth + Edge Functions) |
| Hosting | Railway (static file server) |
| Integrations | Shopify OAuth + Webhooks, Meta OAuth + Ads API |

## Repository structure

```
blue-agency-platform/
├── dashboard.html              # Main analytics dashboard
├── accept-invite.html          # Invitation acceptance page
├── package.json                # Node dependencies (serve)
├── Procfile                    # Railway start command
├── supabase/
│   ├── config.toml             # Supabase local dev config
│   ├── functions/              # Edge Functions (Deno)
│   │   ├── shopify-oauth/      # Shopify store connection
│   │   ├── shopify-webhook/    # Shopify webhook handler
│   │   ├── meta-oauth/         # Meta account connection
│   │   ├── meta-data/          # Meta Ads data fetcher
│   │   ├── meta-token-refresh/ # Scheduled token refresh
│   │   ├── invite-lookup/      # Invitation token lookup
│   │   └── accept-invite/      # Invitation acceptance
│   └── migrations/             # Database migrations (run in order)
│       ├── 20240101000000_initial_schema.sql
│       ├── 20240102000000_webhook_tables.sql
│       ├── 20240103000000_create_org_rpc.sql
│       └── 20240104000000_security_fixes.sql
├── tests/
│   ├── unit/                   # HMAC, state signing, webhook routing
│   ├── integration/            # Auth, orgs, invitations, RLS policies
│   ├── edge-functions/         # Deno tests against running functions
│   ├── e2e/                    # Playwright end-to-end tests
│   └── TESTING.md              # How to run each test category
└── docs/
    └── deployment-guide.docx   # Step-by-step production deployment guide
```

## Quick start (local development)

### 1. Install the Supabase CLI

```bash
npm install -g supabase
```

### 2. Start local Supabase

```bash
supabase start
```

This starts a local Postgres, Auth, and Edge Function runtime. Copy the output URLs and keys.

### 3. Run the database migrations

```bash
supabase db push
```

Or paste each file in `supabase/migrations/` into the Supabase SQL Editor in order.

### 4. Set Edge Function secrets

```bash
supabase secrets set SHOPIFY_CLIENT_ID=...
supabase secrets set SHOPIFY_CLIENT_SECRET=...
supabase secrets set META_APP_ID=...
supabase secrets set META_APP_SECRET=...
supabase secrets set JWT_SECRET=...
supabase secrets set DASHBOARD_URL=http://localhost:3000
```

### 5. Serve the Edge Functions

```bash
supabase functions serve
```

### 6. Serve the dashboard

```bash
npm install
npm run dev
# Opens at http://localhost:3000
```

## Deploying to production

See `docs/deployment-guide.docx` for the complete step-by-step guide covering:

- GitHub setup
- Supabase cloud project
- Railway deployment
- Shopify Partner Dashboard configuration
- Meta Developers App configuration
- Environment variables reference
- Cron job setup
- Custom domain
- Production checklist (30 items)

## Running tests

```bash
# Unit tests (no external deps)
cd tests && npm install && npm run test:unit

# Integration tests (requires supabase start)
npm run test:integration

# Edge function tests (requires supabase functions serve)
deno test tests/edge-functions/ --allow-env --allow-net

# E2E tests (requires running dashboard + supabase)
npm run test:e2e
```

See `tests/TESTING.md` for the full test runner guide.

## Key features

- **Multi-tenant** — organizations with owner / admin / analyst / viewer roles
- **Row Level Security** — every table is RLS-protected; users can only see their own org's data
- **Token-safe views** — `shopify_stores_safe` and `meta_business_managers_safe` strip access tokens before exposing data to the browser
- **Shopify Webhooks** — orders sync automatically; GDPR redact webhooks are handled
- **Meta token refresh** — scheduled cron job extends tokens before the 60-day expiry
- **Invitation flow** — email invitations with role assignment and expiry
- **All Accounts view** — aggregate KPIs across all connected ad accounts
