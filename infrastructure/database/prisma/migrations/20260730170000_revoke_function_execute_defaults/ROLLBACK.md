# ROLLBACK — 20260730170000_revoke_function_execute_defaults

Migration 0016 (Slice 1.6) revokes EXECUTE on every routine in schema `public`
from the Supabase API roles **and from PUBLIC**, and revokes the matching
`ALTER DEFAULT PRIVILEGES` so new functions cannot inherit either grant.

Privileges only — no schema, data or behaviour changes. `eva_app` keeps its
EXECUTE on `list_active_organisations()`, and the `ensure_rls` event trigger
keeps working because event-trigger functions are invoked by the trigger
machinery, not through a caller's EXECUTE privilege.

## Rollback SQL

```sql
-- Restores the stock Postgres + Supabase posture. Only do this knowingly: it
-- hands EXECUTE on every public function back to PUBLIC and to the roles behind
-- the public anon key.
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('GRANT EXECUTE ON ALL ROUTINES IN SCHEMA public TO %I', api_role);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I',
        api_role
      );
    END IF;
  END LOOP;
END $$;

GRANT EXECUTE ON ALL ROUTINES IN SCHEMA public TO PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
```

## Notes

- **No data loss.** Privileges only.
- **What would need this rolled back:** a function in `public` that must be
  callable through Supabase's REST/RPC layer as `anon` / `authenticated` /
  `service_role`. There is none today — the only two public functions are
  `list_active_organisations()` (eva_app only, by design since migration 0010)
  and the hosted-only `rls_auto_enable()` (never called directly). If a future
  slice does need an RPC function, grant EXECUTE to that one function for that
  one role in its own migration rather than restoring these blanket grants.
- **Consequence worth keeping:** with the default privileges gone, a new public
  function is created with no grants at all, so a missing explicit
  `GRANT EXECUTE ... TO eva_app` now fails loudly at runtime instead of
  silently working because PUBLIC had EXECUTE. That is the intended trade.
- Verified before writing: schema `public` contains exactly two functions and
  every extension lives in `extensions` / `pg_catalog` / `vault`, so this
  migration cannot affect extension code.
