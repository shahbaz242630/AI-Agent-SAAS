-- Slice 1.6 — migration 0016: close the FUNCTION half of the privilege gap
-- that migration 0014 closed for tables.
--
-- Found by scripts/verify-supabase-acl.sql on its first hosted run
-- (2026-07-30), immediately after 0014. Two holes remained:
--
-- 1. `ALTER DEFAULT PRIVILEGES ... ON FUNCTIONS` still granted EXECUTE to
--    anon / authenticated / service_role, so every NEW public function would
--    auto-grant to them. That default is the only reason the repo needed a
--    standing "every new function must revoke EXECUTE" rule — 0012 removed the
--    grant from one function without removing the mechanism that created it.
-- 2. Postgres itself grants EXECUTE on new functions to PUBLIC. Migration 0010
--    revoked that for list_active_organisations() specifically, again without
--    removing the default. The hosted-only `rls_auto_enable()` (security gap
--    G-010) showed both holes at once: its ACL was
--    `{=X/postgres, postgres=X, anon=X, authenticated=X, service_role=X}`.
--
-- Revoking across ALL ROUTINES rather than naming functions means this also
-- cleans `rls_auto_enable()`, which exists on Supabase but in no repo migration
-- (G-010 tech debt — the function and its `ensure_rls` event trigger still need
-- codifying; this only fixes their ACL). Verified safe first: schema `public`
-- holds exactly two functions, and every installed extension lives in
-- `extensions` / `pg_catalog` / `vault`, so nothing outside our own code is
-- touched.
--
-- Neither hole was exploitable: `rls_auto_enable()` returns `event_trigger`, so
-- Postgres refuses to invoke it outside trigger context regardless of who holds
-- EXECUTE, and `list_active_organisations()` was already correctly scoped to
-- eva_app. This is least privilege and defence in depth, not incident response.
--
-- Guarded for plain Postgres (local Docker, CI), where the Supabase API roles
-- exist only because migration 0015 creates them.

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM %I', api_role);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END $$;

-- PUBLIC is a pseudo-role, always present — no guard needed. Postgres grants
-- EXECUTE on every new function to PUBLIC unless told otherwise, so both the
-- existing grants and the default have to go.
REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
