# ROLLBACK — 20260801100000_organisation_modules

Migration 0017 (Slice 1.6a) creates `organisation_modules` (which of the four
products an organisation holds, and how many seats of each), with RLS
enabled+forced, the `tenant_isolation` policy, explicit `eva_app` grants, CHECK
constraints on `module_key` / `source` / `seats`, and a partial unique index on
`(organisation_id, module_key)`.

It also **supersedes slice 1.6 ruling 6** by reshaping `email_accounts`: the
one-live-mailbox-per-organisation index is replaced by a one-live-*address*
index, and `is_primary` is added with its own single-primary index.

Both halves backfill: every existing organisation is granted
`email_credit_controller`, and every live mailbox becomes its organisation's
primary.

## Rollback SQL

```sql
-- Mailbox seats: restore the ruling-6 shape.
DROP INDEX IF EXISTS "email_accounts_single_primary_key";
DROP INDEX IF EXISTS "email_accounts_live_address_key";
ALTER TABLE "email_accounts" DROP COLUMN IF EXISTS "is_primary";

-- WILL FAIL if any organisation has more than one live mailbox — see Notes.
CREATE UNIQUE INDEX "email_accounts_live_organisation_key"
  ON "email_accounts"("organisation_id")
  WHERE "deleted_at" IS NULL;

-- Entitlements.
DROP TABLE IF EXISTS organisation_modules;
```

(Dropping the table drops its indexes, constraints, policy and grants with it;
the `eva_app` grant dies with the table.)

## Notes

- **The `email_accounts` half is NOT cleanly reversible once used.** Recreating
  `email_accounts_live_organisation_key` fails if any organisation has taken
  advantage of a second seat, because two live rows now share an
  `organisation_id`. Rolling back then requires a human decision about *which*
  mailbox to keep — there is no correct automatic answer, and picking one
  silently disconnects a mailbox a customer is relying on. Soft-delete the
  surplus rows deliberately first, or prefer a forward corrective migration
  (BRD 18, forward-only convention).
- **Data loss on the entitlements half:** total for `organisation_modules`.
  Every module toggle and seat count is destroyed. Re-applying recreates the
  table and re-runs the backfill, so every organisation returns to
  "email credit controller, 1 seat, manual" — any organisation that had been
  granted a second product, or extra seats, loses that and must be re-granted.
- **Enforcement fails OPEN after rollback, not closed.** With the table gone,
  `requirePermission`'s module step has nothing to consult. That is the safe
  direction for a rollback (customers keep working) but it means a rollback
  silently restores access to products nobody is entitled to. Do not leave a
  rolled-back deployment running longer than it takes to fix forward.
