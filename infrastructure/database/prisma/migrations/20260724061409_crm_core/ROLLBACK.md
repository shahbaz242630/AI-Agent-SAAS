# ROLLBACK — 20260724061409_crm_core

This migration creates the Slice 1.1 CRM core tables (`customers`, `contacts`,
`suppression_list`, `organisation_role_permissions`) with RLS tenant-isolation
policies, and revokes UPDATE/DELETE on `suppression_list` from the runtime
role `eva_app` (permanence, BRD hard rule).

## Rollback SQL

```sql
-- Restore default runtime grants BEFORE dropping the revoke (order irrelevant
-- once the table is dropped, but kept explicit for partial rollbacks).
GRANT UPDATE, DELETE ON suppression_list TO eva_app;

DROP TABLE IF EXISTS organisation_role_permissions;
DROP TABLE IF EXISTS suppression_list;
DROP TABLE IF EXISTS contacts;
DROP TABLE IF EXISTS customers;
```

Dropping the tables also drops their RLS policies, indexes and foreign keys —
no separate `DROP POLICY` steps are needed.

## Notes

- **Data loss:** rollback destroys all customer, contact, suppression and
  custom-permission data. Export first if the tables hold real rows; the
  suppression list is legally significant (PECR) and must NEVER be casually
  dropped in staging/production.
- Re-applying after rollback re-runs the full migration including the REVOKE —
  no manual steps.
- Forward-only convention (BRD 18): prefer a new corrective migration over
  rolling back once real data exists.
