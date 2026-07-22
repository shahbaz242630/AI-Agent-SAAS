-- Slice 0.3 — RLS tenant isolation (BRD 9.4/15; docs/SECURITY-TESTING-STRATEGY.md §3.1).
-- Two layers: the app scopes every query (Prisma helper) AND Postgres refuses
-- cross-tenant access itself. This migration builds the database layer.

-- 1) Runtime application role. NOSUPERUSER + NOBYPASSRLS are the whole point:
--    superusers and BYPASSRLS roles ignore RLS entirely.
--    NOTE: password shown is the LOCAL/CI-ONLY credential (same precedent as
--    POSTGRES_PASSWORD=eva in docker-compose). Staging/production roles are
--    created with a secret-managed password outside this migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'eva_app') THEN
    CREATE ROLE eva_app LOGIN PASSWORD 'eva_app' NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO eva_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO eva_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO eva_app;

-- 2) ENABLE + FORCE RLS on every tenant-owned table. FORCE closes the
--    table-owner bypass trap (migrations run as the owner).
ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisations FORCE ROW LEVEL SECURITY;
ALTER TABLE organisation_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE organisation_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

-- 3) Policies. Tenant context arrives per-transaction via
--    SELECT set_config('app.current_org'/'app.current_user', <id>, true).
--    Missing context => NULL => no rows visible (fail closed).

-- organisations: visible only as the active tenant.
CREATE POLICY tenant_isolation ON organisations
  USING (id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- organisation_settings: strictly per active tenant.
CREATE POLICY tenant_isolation ON organisation_settings
  USING (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- memberships: a user may resolve their OWN memberships across orgs (login
-- path); within an org context, members see fellow members. Writes only into
-- the active tenant.
CREATE POLICY tenant_isolation ON organisation_memberships
  USING (
    user_id = NULLIF(current_setting('app.current_user', true), '')::uuid
    OR organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid
  )
  WITH CHECK (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- users: yourself, plus members of the active tenant.
CREATE POLICY tenant_isolation ON users
  USING (
    id = NULLIF(current_setting('app.current_user', true), '')::uuid
    OR id IN (
      SELECT user_id FROM organisation_memberships
      WHERE organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid
    )
  )
  WITH CHECK (id = NULLIF(current_setting('app.current_user', true), '')::uuid);

-- audit_logs: strictly per active tenant (append-only enforced at app layer).
CREATE POLICY tenant_isolation ON audit_logs
  USING (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
