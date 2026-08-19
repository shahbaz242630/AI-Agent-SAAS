# ROLLBACK — 20260819160000_split_lead_follow_up

Migration 0025 retires the placeholder product key `lead_follow_up_agent` and
replaces it with two real ones — `lead_follow_up_email` and
`lead_follow_up_voice`. Founder ruling 2026-08-19: chasing an enquiry by email
and chasing one by phone are separate purchases with different machinery behind
them.

No table is created or dropped and no column changes. One CHECK constraint is
replaced, and one `UPDATE` re-points any surviving placeholder row.

| Table                  | Changed                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `organisation_modules` | `organisation_modules_module_key_check` — 4 keys become 5   |
| `organisation_modules` | rows with `module_key = 'lead_follow_up_agent'` → `…_email` |

## Rollback SQL

```sql
ALTER TABLE "organisation_modules"
  DROP CONSTRAINT IF EXISTS "organisation_modules_module_key_check";

-- ⚠️ SEE THE FIRST NOTE BELOW BEFORE RUNNING THIS.
UPDATE "organisation_modules"
   SET "module_key" = 'lead_follow_up_agent'
 WHERE "module_key" IN ('lead_follow_up_email', 'lead_follow_up_voice');

ALTER TABLE "organisation_modules"
  ADD CONSTRAINT "organisation_modules_module_key_check"
    CHECK ("module_key" IN (
      'email_credit_controller',
      'voice_credit_controller',
      'lead_follow_up_agent',
      'ai_receptionist'
    ));
```

## Notes

- **⚠️ THE ROLLBACK IS LOSSY, AND IT IS THE ONLY LOSSY THING HERE.** Forward,
  one key becomes two. Backward, two become one — so an organisation holding
  BOTH lead products collapses to a single row, and which of the two it was is
  gone. Worse, if an org holds both, the reverse `UPDATE` produces two rows with
  the same key and **violates the partial unique index** on
  `(organisation_id, module_key) WHERE deleted_at IS NULL` — the statement fails
  rather than corrupting anything, which is the right way round, but it means
  **the rollback cannot be run blind.** Check first:

  ```sql
  SELECT organisation_id, count(*) FROM organisation_modules
   WHERE module_key IN ('lead_follow_up_email','lead_follow_up_voice')
     AND deleted_at IS NULL
   GROUP BY 1 HAVING count(*) > 1;
  ```

  Any row returned must be resolved by hand before rolling back.

- **Today the rollback is free.** Neither lead product is built (`live: false` in
  `MODULE_CATALOGUE`), so the API refuses to enable either one and no
  organisation can hold them. Local `eva` had zero rows for any lead key when
  this migration was written. The lossy case above becomes real only once one of
  them ships.

- **The forward `UPDATE` is expected to affect nothing.** `lead_follow_up_agent`
  was a placeholder that granted no permissions. It was, however, genuinely
  switchable-on before 2026-08-18 — the phantom-products defect — so a row may
  exist in an environment not readable from the development machine. The
  statement is there because "expected" is not "guaranteed".

- **⚠️ THE APPLICATION CODE MUST MOVE WITH THE CONSTRAINT.** `MODULE_KEYS` in
  `@eva/types` is the same list, and `PERMISSION_MODULES`, `MODULE_CAPABILITIES`
  and `MODULE_CATALOGUE` are all keyed by it. Rolling back the database without
  reverting `@eva/types` leaves the API offering two products the database will
  refuse with a CHECK violation — a 500, not a clean refusal. Revert both in the
  same change.

- **No privilege changes.** `organisation_modules` keeps its RLS, its
  `tenant_isolation` policy and its `eva_app` grants; replacing a CHECK does not
  touch them, and `scripts/verify-supabase-acl.sql` has nothing new to assert.
