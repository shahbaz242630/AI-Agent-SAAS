# ROLLBACK — 20260730150000_revoke_table_privileges_from_supabase_api_roles

Migration 0014 (Slice 1.6) revokes ALL table privileges on every `public` table
from the Supabase API roles `anon` / `authenticated` / `service_role`, and
revokes the owner's ALTER DEFAULT PRIVILEGES for tables and sequences so future
tables do not inherit them again.

No schema, data or application behaviour changes — privileges only. The runtime
role (`eva_app`) and the migration owner are untouched.

## Rollback SQL

```sql
-- Restores Supabase's stock posture. Only do this knowingly: it hands the
-- PUBLIC anon key full table privileges again, on every tenant table.
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO %I', api_role);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO %I',
        api_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO %I',
        api_role
      );
    END IF;
  END LOOP;
END $$;
```

## Notes

- **No data loss.** Privileges only; nothing is dropped.
- **Vacuous on plain Postgres** (local Docker, CI): the three roles do not
  exist there, so every statement is skipped by the `pg_roles` guard. The
  effect is only observable on Supabase.
- **What would need this rolled back:** something legitimately reaching our
  tables through Supabase's REST/GraphQL API or Realtime as `anon` /
  `authenticated` / `service_role`. Nothing does today — the API connects
  directly as `eva_app`, the web app uses Supabase only for auth, and
  `SUPABASE_SERVICE_ROLE_KEY` is an unused empty placeholder in `.env.example`.
  Prefer granting the one privilege the one table needs over restoring all of
  this.
- Supabase Studio (Table Editor, SQL Editor) runs as the database owner, not
  through these roles, so it keeps working.
