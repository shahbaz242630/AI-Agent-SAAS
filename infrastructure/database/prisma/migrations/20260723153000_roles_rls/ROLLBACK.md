# ROLLBACK — 20260723153000_roles_rls

This migration enables RLS on the shared `roles` reference table and adds a
read-only policy for the runtime role.

## Rollback SQL

```sql
DROP POLICY IF EXISTS roles_read_all ON roles;
ALTER TABLE roles DISABLE ROW LEVEL SECURITY;
```

## Notes

- On Supabase cloud, the platform may re-enable RLS on `roles` automatically
  (its default for new tables). If so, after rollback you must ALSO recreate
  the read policy manually or the runtime role will lose read access:

  ```sql
  CREATE POLICY roles_read_all ON roles FOR SELECT USING (true);
  ```

- Verified locally against `eva_test` 2026-07-23: after rollback, eva_app
  regains raw table grants (pre-RLS behaviour) and the RLS spec's shared
  reference table tests fail as expected (proving the test detects the gap).
