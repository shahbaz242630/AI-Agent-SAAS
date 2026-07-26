-- Slice 1.5 — migration 0010: reconcile-sweep organisation enumeration
-- (founder ruling 2026-07-26, Phase 1.5 plan §7.8 Option A).
--
-- RLS policies require app.current_org, so the eva_app runtime role cannot
-- enumerate organisations for the daily reconcile sweep. This owner-owned
-- SECURITY DEFINER function is the ONLY controlled cross-tenant path: it
-- returns organisation ids (and nothing else) for orgs with at least one
-- live active invoice. All table access still happens under per-org RLS in
-- the sweep's tenant transactions.
--
-- Owner note: the migration role (eva locally, postgres on Supabase) is a
-- superuser, so the function's definer-side read of invoices is not blocked
-- by FORCE RLS. search_path is pinned to pg_catalog and the table reference
-- is schema-qualified (SECURITY DEFINER hardening).

CREATE FUNCTION list_active_organisations()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT DISTINCT organisation_id
  FROM public.invoices
  WHERE status = 'active' AND deleted_at IS NULL
$$;

REVOKE ALL ON FUNCTION list_active_organisations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_active_organisations() TO eva_app;
