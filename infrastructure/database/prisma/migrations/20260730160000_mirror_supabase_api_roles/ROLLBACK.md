# ROLLBACK — 20260730160000_mirror_supabase_api_roles

Migration 0015 (Slice 1.6) creates the Supabase API roles `anon` /
`authenticated` / `service_role` as `NOLOGIN` roles when they are absent, so
the ACL assertions added by migrations 0012 and 0014 stop being vacuous on
local Docker and in CI. It also re-asserts 0014's revoke idempotently.

No schema or data changes. On Supabase the roles already exist, so nothing is
created there.

## Rollback SQL

```sql
-- Only drop what this migration created: the roles are NOLOGIN and hold no
-- privileges, so nothing depends on them. DROP ROLE fails loudly if that ever
-- stops being true, which is the desired behaviour.
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role AND NOT rolcanlogin) THEN
      EXECUTE format('DROP ROLE %I', api_role);
    END IF;
  END LOOP;
END $$;
```

## Notes

- **Never run this against Supabase.** There the three roles are platform
  infrastructure that PostgREST, Auth and the dashboard depend on; dropping
  them would break the project. The `NOT rolcanlogin` filter is not a
  sufficient guard on its own — Supabase's roles are also NOLOGIN. Treat this
  rollback as local/CI only.
- Rolling back re-introduces the vacuity: the 0012/0014 ACL tests would pass
  without checking anything, and the "API roles exist" guard test in
  `schema-conventions.spec.ts` would fail — which is the intended signal.
- No data loss.
