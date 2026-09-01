# ROLLBACK — 20260901100000_a_mailbox_belongs_to_one_product

Migration 0034 gives `email_accounts` a `module_key` column and re-scopes two
unique indexes from "per organisation" to "per organisation, per product".

| Change    | Detail                                                                                    |
| --------- | ----------------------------------------------------------------------------------------- |
| Added     | `email_accounts.module_key` (TEXT NOT NULL, no default)                                   |
| Added     | `email_accounts_module_key_check` — the five `MODULE_KEYS`                                |
| Rebuilt   | `email_accounts_live_address_key` → `(organisation_id, module_key, lower(email_address))` |
| Rebuilt   | `email_accounts_single_primary_key` → `(organisation_id, module_key)`                     |
| Added     | `email_accounts_organisation_module_idx`                                                  |
| Unchanged | every other column, all RLS policies, all grants, `customers.email_account_id`            |

## Before rolling back

```sql
-- 1. Mailboxes belonging to anything but Invoice Chasing. These have no home
--    in the old schema at all.
SELECT module_key, count(*)
FROM email_accounts
WHERE deleted_at IS NULL
GROUP BY module_key;

-- 2. Addresses connected to MORE THAN ONE product. The old address index
--    forbids these outright.
SELECT organisation_id, lower(email_address), count(*)
FROM email_accounts
WHERE deleted_at IS NULL
GROUP BY organisation_id, lower(email_address)
HAVING count(*) > 1;

-- 3. Organisations with more than one default mailbox. The old primary index
--    forbids these outright.
SELECT organisation_id, count(*)
FROM email_accounts
WHERE is_primary AND deleted_at IS NULL
GROUP BY organisation_id
HAVING count(*) > 1;
```

**⚠️ IF QUERY 2 OR 3 RETURNS ANY ROW, THE ROLLBACK WILL FAIL** — Postgres
validates a unique index against existing rows and refuses rather than silently
dropping the ones that violate it. That refusal is correct behaviour, not a
fault.

**⚠️ AND IF QUERY 1 SHOWS ANY `lead_follow_up_email` ROW, ROLLING BACK LOSES
INFORMATION THAT CANNOT BE RECOVERED.** The old schema has nowhere to record
which product a mailbox was for, so every mailbox becomes the organisation's
again — Lead Follow-up's mailbox silently becomes Invoice Chasing's, sending
that customer's invoice chasers out of the address they chose for lead replies.
Dropping the column is the easy half; the meaning does not come back.

**Do not "fix" a failing rollback by deleting rows.** Each of these is a
customer's live OAuth grant and a paid seat. Disconnect through the API first —
that soft-deletes, reassigns any filed clients, frees the seat and writes the
audit trail — and only then narrow the indexes.

## Rollback SQL

```sql
BEGIN;

DROP INDEX "email_accounts_organisation_module_idx";

DROP INDEX "email_accounts_single_primary_key";
CREATE UNIQUE INDEX "email_accounts_single_primary_key"
  ON "email_accounts"("organisation_id")
  WHERE "is_primary" AND "deleted_at" IS NULL;

DROP INDEX "email_accounts_live_address_key";
CREATE UNIQUE INDEX "email_accounts_live_address_key"
  ON "email_accounts"("organisation_id", lower("email_address"))
  WHERE "deleted_at" IS NULL;

ALTER TABLE "email_accounts" DROP CONSTRAINT "email_accounts_module_key_check";
ALTER TABLE "email_accounts" DROP COLUMN "module_key";

COMMIT;
```

Run it as one transaction: the two index swaps must both succeed or neither
should, or the table is left with the old address rule and the new primary rule
at once — a state no code in either direction expects.

## What the application does after a rollback

Every read of `module_key` disappears with the code that is rolled back
alongside it. If the column is dropped while the NEW api is still running, every
mailbox connect fails immediately (the INSERT names a column that is gone) and
every send resolution throws. **Roll the code back first, then the schema** —
the reverse of the deploy order, which is migration → merge → deploy.
