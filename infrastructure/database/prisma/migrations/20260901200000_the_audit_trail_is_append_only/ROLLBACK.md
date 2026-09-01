# ROLLBACK — 20260901200000_the_audit_trail_is_append_only

Migration 0037 removes two privileges from the application role `eva_app` on one
table. It creates nothing, drops nothing, and touches no data.

| Change    | Detail                                              |
| --------- | --------------------------------------------------- |
| Revoked   | `UPDATE`, `DELETE` on `audit_logs` from `eva_app`   |
| Unchanged | every row, column, index, constraint and RLS policy |
| Unchanged | every other table's grants                          |
| Unchanged | the OWNER role `eva`, which keeps everything        |

`eva_app` keeps `INSERT` and `SELECT`, which is all the writer needs — every
tenant mutation appends an entry inside its own transaction and nothing has ever
read one back to change it.

## Before rolling back

Nothing to check. No data is at risk either way; this only narrows what the
running application may do.

⚠️ **BUT ASK WHY FIRST.** A rollback re-grants the application the ability to
rewrite and destroy its own audit trail. If something is failing, the far
likelier cause is a new code path that tried to update or delete an audit row —
and the right fix is that code, because BRD 15 says the trail is append-only.

## How to tell if this migration is the cause

A refused write fails loudly and names the table:

```
permission denied for table audit_logs
```

If an error does not say `permission denied for table audit_logs`, this
migration is not why.

```sql
-- What the application may currently do to the trail. Expect INSERT, SELECT.
SELECT privilege_type FROM information_schema.role_table_grants
WHERE grantee = 'eva_app' AND table_name = 'audit_logs'
ORDER BY privilege_type;
```

## Rollback SQL

```sql
BEGIN;

GRANT UPDATE, DELETE ON "audit_logs" TO eva_app;

COMMIT;
```

## What the application does after a rollback

Nothing changes in behaviour. No code path updates or deletes an audit row —
verified before writing the migration with
`grep -rE "\.(delete|deleteMany)\(" apps/*/src`, which returns exactly one hit
in the entire codebase (`organisationRolePermission.deleteMany`, a different
table, deliberately untouched).

So a rollback restores an ability nothing uses. That is precisely why the grants
sat unnoticed for eleven sessions: **an unused privilege is invisible until
something goes wrong with it.**

⚠️ **AND `grants.spec.ts` WILL GO RED.** It attempts an `UPDATE` and a `DELETE`
on `audit_logs` as `eva_app` and expects both to be refused. A rollback makes
them succeed and the suite says so — the guard working, not a fault in it.

## ⚠️ The wider gap this migration deliberately did NOT close

Auditing the grants found that `eva_app` also holds `DELETE` on **18 other
tables** it never hard-deletes, and `INSERT`/`UPDATE`/`DELETE` on `roles`.
Revoking those was written, tested and then removed from this migration, because
it breaks two things that each need their own review:

- six isolation tests probe RLS with a cross-tenant `DELETE`, which would then
  fail on privileges **before** the policy is consulted;
- four `tenant.spec.ts` fixtures clean up with `DELETE` as `eva_app`, so cleanup
  silently stops and the next run collides on a unique constraint.

`grants.spec.ts` asserts that gap **as a gap**, so it stays counted rather than
forgotten, and it goes red the day somebody closes part of it without doing the
surrounding work.
