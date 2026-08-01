-- Slice 1.6a — migration 0018: a disabled module must stop OUTBOUND ACTION,
-- not merely hide a button.
--
-- `requirePermission` guards user requests. It does nothing about the nightly
-- reconcile sweep, which enumerates organisations through this function and
-- schedules reminders for each — so before this change a customer could switch
-- Invoice Chasing off and have Eva carry on quietly chasing their customers.
-- That is the actual teeth of BRD §3.4, and the cheapest single place to fit
-- them is the enumeration itself.
--
-- Belt and braces by design: this stops work being SCHEDULED; slice 1.7's
-- sender re-checks inside its claim transaction to stop anything already
-- scheduled being SENT.
--
-- CREATE OR REPLACE rather than DROP + CREATE: replacing preserves the
-- function's ACL, where dropping would silently discard the eva_app grant and
-- break the sweep at runtime. The grants below are re-issued anyway, because
-- since migrations 0014–0016 there is no default privilege left to inherit and
-- `scripts/verify-supabase-acl.sql` asserts eva_app keeps EXECUTE.

CREATE OR REPLACE FUNCTION list_active_organisations()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT DISTINCT i.organisation_id
  FROM public.invoices i
  WHERE i.status = 'active'
    AND i.deleted_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.organisation_modules m
      WHERE m.organisation_id = i.organisation_id
        AND m.module_key = 'email_credit_controller'
        AND m.enabled
        AND m.deleted_at IS NULL
    )
$$;

REVOKE ALL ON FUNCTION list_active_organisations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_active_organisations() TO eva_app;
