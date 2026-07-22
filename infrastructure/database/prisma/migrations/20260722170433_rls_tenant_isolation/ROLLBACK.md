# Rollback note — `20260722170433_rls_tenant_isolation` (BRD 9.4: forward-only, documented rollback per migration)

This migration creates the `eva_app` runtime role and enables + forces RLS with
tenant-isolation policies on `organisations`, `organisation_settings`,
`organisation_memberships`, `users`, `audit_logs`.

**Rollback (manual, verified against local Docker Postgres):**

```sql
DROP POLICY IF EXISTS tenant_isolation ON organisations;
DROP POLICY IF EXISTS tenant_isolation ON organisation_settings;
DROP POLICY IF EXISTS tenant_isolation ON organisation_memberships;
DROP POLICY IF EXISTS tenant_isolation ON users;
DROP POLICY IF EXISTS tenant_isolation ON audit_logs;
ALTER TABLE organisations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE organisations DISABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_settings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE organisation_settings DISABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE organisation_memberships DISABLE ROW LEVEL SECURITY;
ALTER TABLE users NO FORCE ROW LEVEL SECURITY;
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY;
DROP ROLE IF EXISTS eva_app;
DELETE FROM _prisma_migrations WHERE migration_name = '20260722170433_rls_tenant_isolation';
```

**Data impact:** none — drops policies/role only, no table or data changes.

**Staging/production note:** the `eva_app` password in this migration is a
LOCAL/CI-ONLY credential (same precedent as `POSTGRES_PASSWORD=eva` in
docker-compose). On hosted Supabase, create the role with a secret-managed
password (dashboard SQL or admin script), then apply the policies from this
migration. Rolling back on hosted environments: run the above in the Supabase
SQL editor as postgres.
