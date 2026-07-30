-- Slice 1.6 — migration 0014: revoke ALL table privileges from the Supabase
-- API roles (anon / authenticated / service_role), and stop future tables
-- inheriting them.
--
-- Supabase's ALTER DEFAULT PRIVILEGES grants arwdDxtm on every new public
-- table to all three roles. `anon` is the PUBLIC api key that ships in browser
-- code, so those grants sat on every tenant table since Phase 0 — including
-- email_accounts, which stores AES-256-GCM-encrypted OAuth tokens.
--
-- Not exploitable when it was found (2026-07-30): RLS is ENABLED and FORCED on
-- every tenant table, and the tenant_isolation policy needs app.current_org,
-- which a PostgREST request can never set — so the roles saw nothing and could
-- write nothing. But it is a spare key under the doormat, and TRUNCATE is NOT
-- subject to RLS, so the lock was doing all the work on its own. Least
-- privilege instead: the runtime uses eva_app, migrations use the owner, and
-- neither of those is touched here.
--
-- This is the table-level twin of migration 0012 (which did the same for
-- function EXECUTE), and it reuses that migration's guard: plain Postgres
-- (local Docker, CI) has no Supabase API roles, so every statement sits behind
-- a pg_roles existence check.
--
-- Scope note: default privileges are recorded per granting role. Only the
-- CREATING role's defaults apply to a new object, and every migration runs as
-- the database owner (postgres on Supabase), so revoking the owner's defaults
-- is what protects our future tables. Supabase's own `supabase_admin` defaults
-- are deliberately left alone — they govern Supabase's internal objects, not
-- ours, and postgres cannot always alter them.

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      -- Existing tables.
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', api_role);

      -- Future tables and sequences created by this role. Without these the
      -- grants would silently return on the next CREATE TABLE.
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I',
        api_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END $$;
