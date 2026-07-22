# Rollback note — `20260722173000_auth_user_resolution` (BRD 9.4: forward-only, documented rollback per migration)

This migration adds a narrow SELECT-only policy `auth_user_resolution` on
`users`, letting the runtime role resolve `auth_user_id → users.id` on the
login path (keyed to the `app.current_auth_user` GUC, fail closed).

**Rollback (manual):**

```sql
DROP POLICY IF EXISTS auth_user_resolution ON users;
DELETE FROM _prisma_migrations WHERE migration_name = '20260722173000_auth_user_resolution';
```

**Data impact:** none — drops a policy only, no table or data changes.
