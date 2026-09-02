# ROLLBACK — 20260902100000_lead_follow_up_is_more_than_email

Migration 0038 renames one product key, `lead_follow_up_email` → `lead_follow_up`,
in the two places the database stores it. It creates no table, drops no column
and loses no row.

| Change    | Detail                                                                  |
| --------- | ----------------------------------------------------------------------- |
| Updated   | `organisation_modules.module_key` — 1 row on production                 |
| Updated   | `email_accounts.module_key` — 0 rows on production                      |
| Replaced  | `organisation_modules_module_key_check` — new list, same five products  |
| Replaced  | `email_accounts_module_key_check` — new list, same five products        |
| Unchanged | every other column, index, RLS policy and grant                         |
| Unchanged | `leads.source` and `lead_evidence.channel`, which are not product names |

## Before rolling back

Count what you are about to move back, and expect the same number the forward
migration moved:

```sql
SELECT 'organisation_modules' AS t, module_key, count(*)
  FROM organisation_modules GROUP BY 1, 2
UNION ALL
SELECT 'email_accounts', module_key, count(*)
  FROM email_accounts GROUP BY 1, 2
ORDER BY 1, 2;
```

⚠️ **AND CHECK WHETHER A MAILBOX WAS CONNECTED SINCE.** The forward migration
moved zero `email_accounts` rows because none existed. If a customer has since
connected a mailbox for Lead Follow-up, a rollback files it against
`lead_follow_up_email` — a key the code will no longer recognise once it is also
rolled back, and one `resolveSendingMailbox` will never match. The mailbox would
still be listed on screen and would silently never send. Roll the code back too,
or reconnect the mailbox afterwards.

## How to tell if this migration is the cause

A row refused by the new constraint names it exactly:

```
new row for relation "organisation_modules" violates check constraint
"organisation_modules_module_key_check"
```

That means something is still writing `lead_follow_up_email` — almost certainly
an API instance running code from before this migration's deploy. The fix is to
finish the deploy, not to roll back: the old code cannot enable the lead product
against the new database, but nothing else it does is affected.

If an error does not name `module_key`, this migration is not why.

## Rollback SQL

```sql
BEGIN;

ALTER TABLE "organisation_modules"
  DROP CONSTRAINT IF EXISTS "organisation_modules_module_key_check";

UPDATE "organisation_modules"
   SET "module_key" = 'lead_follow_up_email'
 WHERE "module_key" = 'lead_follow_up';

ALTER TABLE "organisation_modules"
  ADD CONSTRAINT "organisation_modules_module_key_check"
    CHECK ("module_key" IN (
      'email_credit_controller',
      'voice_credit_controller',
      'lead_follow_up_email',
      'lead_follow_up_voice',
      'ai_receptionist'
    ));

ALTER TABLE "email_accounts"
  DROP CONSTRAINT IF EXISTS "email_accounts_module_key_check";

UPDATE "email_accounts"
   SET "module_key" = 'lead_follow_up_email'
 WHERE "module_key" = 'lead_follow_up';

ALTER TABLE "email_accounts"
  ADD CONSTRAINT "email_accounts_module_key_check"
    CHECK ("module_key" IN (
      'email_credit_controller',
      'voice_credit_controller',
      'lead_follow_up_email',
      'lead_follow_up_voice',
      'ai_receptionist'
    ));

COMMIT;
```

## What the application does after a rollback

⚠️ **NOTHING WORKS UNTIL THE CODE GOES BACK TOO, AND IT FAILS QUIETLY.**

This is not a migration whose rollback is invisible. `MODULE_KEYS` in
`packages/types` is the code half of the same list, and after a rollback the
running application asks for `lead_follow_up` while every row says
`lead_follow_up_email`. The consequences are not exceptions:

- the product reads as **switched off** on the hub, because the entitlement row
  no longer matches any key the code knows;
- `resolveSendingMailbox` finds no mailbox for the product, so an enquiry that
  deserved an answer records `not_sent` with "no mailbox is connected";
- enabling the product again writes `lead_follow_up`, which the restored
  constraint refuses — the one loud failure in the list.

So a rollback of this migration means a rollback of the code that shipped with
it. They are one change in two places, which is exactly why the forward
migration is deployed in the same release.

## Why this was a rename and not a second key

Adding `lead_follow_up` alongside `lead_follow_up_email` and mapping between
them would avoid touching data. It was considered and rejected: two keys for one
product is the phantom-entitlement shape (ruling 18) — a value the database
permits, the catalogue does not sell, and every future query has to remember to
handle. With one row in the world to move, the honest rename costs less than the
compatibility layer it would replace.
