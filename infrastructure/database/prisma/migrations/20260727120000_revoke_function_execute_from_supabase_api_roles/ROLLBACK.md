# ROLLBACK — 20260727120000_revoke_function_execute_from_supabase_api_roles

This migration (0012; Slice 1.5 close-out) revokes `EXECUTE` on
`list_active_organisations()` from the Supabase API roles `anon`,
`authenticated` and `service_role`. Supabase's default privileges auto-grant
`EXECUTE` on new public functions to those roles; migration 0010 only revoked
`PUBLIC`. The revoke was applied manually on cloud Supabase on 2026-07-26 —
this migration codifies it so repo and cloud do not drift. Each `REVOKE` is
guarded by a `pg_roles` existence check because plain Postgres (local Docker,
CI) has no Supabase API roles.

## Rollback SQL

```sql
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION public.list_active_organisations() TO %I',
        api_role
      );
    END IF;
  END LOOP;
END $$;
```

## Notes

- Rollback RE-OPENS the hole this migration closes: the sweep-enumeration
  function becomes callable by Supabase's API roles again (any anon key holder
  could enumerate which organisation ids have live active invoices). Only roll
  back as part of replacing the function's hardening, never on its own.
- No tables, policies or data are touched; rollback has no data impact.
- Re-applying is idempotent — `REVOKE` of a privilege not held is a no-op.
- Forward-only convention (BRD 18): prefer a new corrective migration over
  rolling back once real data exists.
