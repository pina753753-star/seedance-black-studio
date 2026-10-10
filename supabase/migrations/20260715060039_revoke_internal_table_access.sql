-- FlowVid Studio: explicitly restrict internal annual-subscription tables
--
-- Purpose:
--   Keep user_subscriptions and annual_credit_grant_log service-role-only.
--   Both tables already have RLS enabled with no user-facing policies, which
--   currently results in default-deny for anon/authenticated. This migration
--   also removes their table-level privileges so the restriction is explicit.
--
-- Scope:
--   Permission hardening only. No table definitions, rows, functions, credit
--   amounts, subscription state, cron behavior, or production data are changed.
--
-- IMPORTANT:
--   Do not apply to production without explicit human approval.

REVOKE ALL ON TABLE public.user_subscriptions
FROM anon, authenticated;

REVOKE ALL ON TABLE public.annual_credit_grant_log
FROM anon, authenticated;

GRANT ALL ON TABLE public.user_subscriptions
TO service_role;

GRANT ALL ON TABLE public.annual_credit_grant_log
TO service_role;

-- Read-only verification query to run after an approved application:
--
-- SELECT
--   c.relname AS table_name,
--   has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS anon_dml,
--   has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS authenticated_dml,
--   has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS service_role_dml
-- FROM pg_class c
-- JOIN pg_namespace n ON n.oid = c.relnamespace
-- WHERE n.nspname = 'public'
--   AND c.relname IN ('user_subscriptions', 'annual_credit_grant_log')
-- ORDER BY c.relname;
