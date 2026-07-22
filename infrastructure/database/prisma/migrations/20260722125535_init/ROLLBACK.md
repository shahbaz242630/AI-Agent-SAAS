# Rollback note — `20260722125535_init` (BRD 9.4: forward-only, documented rollback per migration)

This migration creates the Phase 0 tables: `organisations`, `organisation_settings`,
`users`, `roles`, `organisation_memberships`, `audit_logs`.

**Rollback (manual, verified against local Docker Postgres):**

```sql
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS organisation_memberships;
DROP TABLE IF EXISTS organisation_settings;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS organisations;
DELETE FROM _prisma_migrations WHERE migration_name = '20260722125535_init';
```

**Data impact:** destructive — drops all Phase 0 tables and their data. Safe in
Phase 0 (no production data yet); from Phase 1 onward, prefer a new corrective
migration over rollback per the forward-only policy.

Verified: applied and rolled back against disposable `postgres:16-alpine` container.
