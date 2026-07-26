# ROLLBACK — 20260726120000_list_active_organisations

This migration (0010; Phase 1.5 plan §7.8, founder ruling 2026-07-26 Option A)
creates the owner-owned `SECURITY DEFINER` function
`list_active_organisations()`, the only controlled cross-tenant enumeration
path: it returns the ids of organisations with at least one live active
invoice so the Slice 1.5 reconcile sweep (running as the `eva_app` runtime
role, which cannot enumerate orgs through RLS) knows which tenant contexts to
enter. `EXECUTE` is revoked from `PUBLIC` and granted to `eva_app` only.

## Rollback SQL

```sql
DROP FUNCTION IF EXISTS list_active_organisations();
```

Dropping the function also drops its grants — no separate `REVOKE` step is
needed. No tables, policies or data are touched by this migration, so rollback
has no data impact.

## Notes

- After rollback, `POST /internal/reminders/reconcile` cannot enumerate
  organisations and processes nothing (the raw `SELECT * FROM
list_active_organisations()` fails per call). Do not roll back past this
  migration while the 1.5 sweep is expected to run.
- Re-applying re-creates the function and its grants in one step — no manual
  follow-up.
- Forward-only convention (BRD 18): prefer a new corrective migration over
  rolling back once real data exists.
