-- Slice 1.5 — migration 0012: harden list_active_organisations() EXECUTE ACL
-- against Supabase's default privileges.
--
-- Supabase auto-grants EXECUTE on new public functions to the API roles
-- anon / authenticated / service_role via ALTER DEFAULT PRIVILEGES. Migration
-- 0010 revoked PUBLIC and granted eva_app, but those three role-level grants
-- remain on Supabase (verified live 2026-07-26; revoked manually on cloud the
-- same day). This migration codifies the manual revoke so repo and cloud do
-- not drift.
--
-- Plain Postgres (local Docker, CI) has no Supabase API roles, so each REVOKE
-- is guarded by a pg_roles existence check inside a DO block.

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION public.list_active_organisations() FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END $$;
