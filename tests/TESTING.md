# Test Suite

A complete test suite covering unit tests, integration tests, edge function tests, and end-to-end tests.

## Structure

```
tests/
├── setup/
│   ├── supabase-helpers.ts   # Shared test utilities (admin client, fixtures)
│   ├── fixtures.ts           # Test constants and payload templates
│   └── vitest-setup.ts       # Vitest global setup (env loading)
├── unit/
│   ├── hmac.test.ts          # HMAC signing/verification (Shopify + Meta OAuth)
│   ├── state-signing.test.ts # OAuth state param signing/verification
│   └── webhook-routing.test.ts # Webhook topic routing + order row builder
├── integration/
│   ├── auth.test.ts          # Auth: sign up, sign in, sign out, RLS
│   ├── organizations.test.ts # Org creation, membership, slugs, settings
│   ├── invitations.test.ts   # Invitation flow: create, accept, expiry, RLS
│   └── rls/
│       ├── shopify-rls.test.ts # Shopify stores + orders RLS policies
│       └── meta-rls.test.ts    # Meta BMs + ad accounts RLS policies
├── edge-functions/           # Deno test runner — tests against running edge functions
│   ├── shopify-webhook.test.ts
│   ├── shopify-oauth.test.ts
│   ├── meta-data.test.ts
│   ├── meta-token-refresh.test.ts
│   └── invite-lookup.test.ts
└── e2e/                      # Playwright — tests against a running dashboard
    ├── global-setup.ts
    ├── global-teardown.ts
    ├── auth.spec.ts
    ├── dashboard.spec.ts
    ├── permissions.spec.ts
    ├── token-expiry.spec.ts
    └── webhooks.spec.ts
```

## Prerequisites

1. **Local Supabase running:** `supabase start`
2. **Edge functions served:** `supabase functions serve`
3. **Dashboard served** (for E2E): `npx serve . -p 3000` or equivalent

## Environment variables

Copy `.env.test.example` to `.env.test` and fill in:

```bash
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=<your local anon key>
SUPABASE_SERVICE_ROLE_KEY=<your local service role key>
SHOPIFY_CLIENT_SECRET=<from supabase secrets>
DASHBOARD_URL=http://localhost:3000
```

Get the keys from `supabase status` after running `supabase start`.

## Running tests

### Unit tests (fast, no external deps)

```bash
cd tests
npm install
npm run test:unit
```

### Integration tests (requires Supabase running)

```bash
npm run test:integration
```

### All Vitest tests (unit + integration)

```bash
npm test
```

### Edge function tests (requires `supabase functions serve`)

```bash
# Run all edge function tests
deno test tests/edge-functions/ --allow-env --allow-net

# Run a specific file
deno test tests/edge-functions/shopify-webhook.test.ts --allow-env --allow-net
```

### End-to-end tests (requires running dashboard + Supabase)

```bash
npm run test:e2e

# With browser visible (headed mode)
npm run test:e2e -- --headed

# A specific spec
npx playwright test tests/e2e/auth.spec.ts
```

### Coverage report

```bash
npm run test:coverage
# Opens coverage/index.html
```

## What's tested

| Area | Test files | Runner |
|------|-----------|--------|
| HMAC verification | `unit/hmac.test.ts` | Vitest |
| OAuth state signing | `unit/state-signing.test.ts` | Vitest |
| Webhook routing + order mapping | `unit/webhook-routing.test.ts` | Vitest |
| Auth (signup, signin, RLS) | `integration/auth.test.ts` | Vitest |
| Organization management | `integration/organizations.test.ts` | Vitest |
| Invitation flow | `integration/invitations.test.ts` | Vitest |
| Shopify RLS policies | `integration/rls/shopify-rls.test.ts` | Vitest |
| Meta RLS policies | `integration/rls/meta-rls.test.ts` | Vitest |
| Shopify webhook handler | `edge-functions/shopify-webhook.test.ts` | Deno test |
| Shopify OAuth flow | `edge-functions/shopify-oauth.test.ts` | Deno test |
| Meta data edge function | `edge-functions/meta-data.test.ts` | Deno test |
| Meta token refresh job | `edge-functions/meta-token-refresh.test.ts` | Deno test |
| Invite lookup endpoint | `edge-functions/invite-lookup.test.ts` | Deno test |
| Auth E2E | `e2e/auth.spec.ts` | Playwright |
| Dashboard UI | `e2e/dashboard.spec.ts` | Playwright |
| Role-based permissions | `e2e/permissions.spec.ts` | Playwright |
| Token expiry reconnect UI | `e2e/token-expiry.spec.ts` | Playwright |
| Webhook → DB → UI pipeline | `e2e/webhooks.spec.ts` | Playwright |

## Cleanup

All test data is cleaned up in `afterAll` / global teardown:
- Test users are deleted via `admin.auth.admin.deleteUser()`
- Test orgs are deleted (cascade removes members, stores, orders, etc.)
- Emails use the `@blue-agency-test.internal` domain for easy identification

To manually nuke all leftover test data:

```sql
-- In Supabase Studio SQL editor
DELETE FROM organizations WHERE name LIKE '%Test%' OR name LIKE '%RLS%' OR name LIKE '%E2E%';
DELETE FROM auth.users WHERE email LIKE '%blue-agency-test.internal';
```
