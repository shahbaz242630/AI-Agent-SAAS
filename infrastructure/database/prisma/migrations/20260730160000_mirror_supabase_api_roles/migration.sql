-- Slice 1.6 — migration 0015: make the Supabase API roles exist locally and in
-- CI, so the ACL assertions that protect against them are not vacuous.
--
-- The problem this solves: migrations 0012 and 0014 revoke privileges from
-- anon / authenticated / service_role, and db tests assert those roles hold
-- nothing. But those roles only exist on Supabase. On local Docker and in CI
-- the assertions queried an empty set and passed no matter what — so a future
-- migration containing `GRANT SELECT ON invoices TO anon` would sail through
-- the whole gate and only be wrong in production.
--
-- Creating the roles here (guarded, following the eva_app precedent in
-- 20260722170433_rls_tenant_isolation) makes those assertions bite everywhere.
-- NOLOGIN matches Supabase: PostgREST reaches them via SET ROLE, never by
-- logging in, so these carry no password and cannot be connected as.
--
-- On Supabase all three already exist, so the creation is skipped and this
-- migration is a no-op there beyond re-asserting 0014's revoke idempotently.
--
-- What this does NOT reproduce: Supabase's ALTER DEFAULT PRIVILEGES, which is
-- what auto-granted on new tables in the first place. 0014 removed that
-- mechanism on the hosted database, and deliberately recreating an insecure
-- default locally to test its removal would be worse than the drift. Hosted
-- privilege drift is covered instead by scripts/verify-supabase-acl.sql.

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS', api_role);
    END IF;

    -- Idempotent re-assertion of migration 0014: these roles must hold nothing.
    -- Newly created roles hold nothing anyway; this keeps local and hosted in
    -- the same end state whichever order the two migrations first ran in.
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', api_role);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I',
      api_role
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I',
      api_role
    );
  END LOOP;
END $$;
