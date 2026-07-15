-- FlowVid Studio: restrict annual credit grant RPC execution
--
-- Purpose:
--   Remove direct EXECUTE access from PUBLIC, anon, and authenticated.
--   Keep service_role as the only intended caller.
--
-- Scope:
--   Permission hardening only.
--   This migration does not change function bodies, grant-period calculation,
--   credit amounts, expiry calculation, cron behavior, or production data.
--
-- IMPORTANT:
--   Review and obtain explicit human approval before applying to production.

DO $$
BEGIN
  -- Legacy 3-argument overload.
  IF to_regprocedure(
    'public.grant_annual_subscription_credits(text,date,timestamp with time zone)'
  ) IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.grant_annual_subscription_credits(text, date, timestamptz) FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION public.grant_annual_subscription_credits(text, date, timestamptz) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION public.grant_annual_subscription_credits(text, date, timestamptz) FROM authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.grant_annual_subscription_credits(text, date, timestamptz) TO service_role';
  END IF;

  -- Current 4-argument overload.
  -- Conditional so the migration remains safe when this overload has not yet
  -- been deployed to the target database.
  IF to_regprocedure(
    'public.grant_annual_subscription_credits(text,date,timestamp with time zone,timestamp with time zone)'
  ) IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.grant_annual_subscription_credits(text, date, timestamptz, timestamptz) FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION public.grant_annual_subscription_credits(text, date, timestamptz, timestamptz) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION public.grant_annual_subscription_credits(text, date, timestamptz, timestamptz) FROM authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.grant_annual_subscription_credits(text, date, timestamptz, timestamptz) TO service_role';
  END IF;
END
$$;

-- Read-only verification query to run after an approved application:
--
-- SELECT
--   p.oid::regprocedure::text AS signature,
--   p.prosecdef AS security_definer,
--   p.proacl,
--   has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
--   has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
--   has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
--   has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_execute
-- FROM pg_proc p
-- JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public'
--   AND p.proname = 'grant_annual_subscription_credits'
-- ORDER BY p.oid::regprocedure::text;
