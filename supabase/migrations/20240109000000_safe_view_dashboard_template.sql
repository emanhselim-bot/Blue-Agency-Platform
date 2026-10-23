-- meta_ad_accounts_safe: expose dashboard_template
--
-- loadAccounts() asks this view for dashboard_template and the view did not
-- have it. PostgREST answers a select naming an unknown column with 400 for
-- the whole request, so the account list came back empty: nothing in the
-- account picker, every platform tab greyed out, and an empty state claiming
-- Meta had never been connected -- on an organization with 99 active Meta
-- accounts. Nothing in the UI said a query had failed.
--
-- The column was added to that select when the dashboard template stopped
-- being agency-wide and became per account. The view was not updated to match,
-- and nothing compares the two.
--
-- It belongs in the view. The template decides which cards a client's
-- dashboard renders, the browser is what renders them, and it is not a secret.
-- This view exists to keep access tokens out of the browser; a template name
-- is not one.
create or replace view public.meta_ad_accounts_safe
with (security_invoker = true) as
  select id, organization_id, business_manager_id, meta_account_id, account_name,
         currency, timezone, account_status, shopify_store_id, clarity_project_id,
         is_active, has_active_campaigns, campaigns_last_synced_at, connected_at,
         updated_at, site_tracker_id, ga4_property_id, business_type, agency_id,
         notion_url, notion_synced_at, notion_sync_note,
         dashboard_template
  from public.meta_ad_accounts;
