# ROLLBACK — 20260821200000_a_mailbox_may_be_gmail

Migration 0030 widens one CHECK so a mailbox row may name Google as well as
Microsoft. No column, index, policy or grant changes.

| Change    | Detail                                                         |
| --------- | -------------------------------------------------------------- |
| Widened   | `email_accounts_provider_check` → `IN ('microsoft', 'google')` |
| Unchanged | every column, index, RLS policy and grant on `email_accounts`  |

## Before rolling back

```sql
-- Mailboxes that the narrowed constraint would refuse.
SELECT count(*) FROM email_accounts WHERE provider = 'google';

-- The ones that are live, i.e. someone is relying on them right now.
SELECT id, organisation_id, email_address, health_status
FROM email_accounts
WHERE provider = 'google' AND deleted_at IS NULL;
```

**⚠️ IF THE FIRST QUERY RETURNS ANYTHING BUT `0`, THE ROLLBACK WILL FAIL** — and
that is correct behaviour, not a fault. Postgres validates a new CHECK against
existing rows, so it refuses rather than silently leaving rows the constraint
forbids.

**Do not "fix" that by deleting the rows.** A connected Gmail mailbox is a
customer's live grant: deleting it drops every client allocation filed against
it (slice 1.6b), frees a seat that was paid for, and stops their chasers with no
explanation on any screen. If a rollback is genuinely required, disconnect those
mailboxes through the API first — which soft-deletes them, reassigns their
clients and writes the audit trail — and only then narrow the constraint.

## Rollback SQL

```sql
ALTER TABLE "email_accounts" DROP CONSTRAINT "email_accounts_provider_check";

ALTER TABLE "email_accounts"
  ADD CONSTRAINT "email_accounts_provider_check" CHECK ("provider" = 'microsoft');
```

## Notes

- **⚠️ THE APPLICATION MUST GO BACK TOO, AND IT WILL FAIL LOUDLY IF IT DOES
  NOT.** `mailbox-providers.spec.ts` asserts that this CHECK and
  `MAIL_PROVIDER_KEYS` name the same providers, so code claiming Gmail support
  against a narrowed constraint fails CI rather than production. That test is
  the whole reason this migration is safe to reverse.

- **Rolling back does not revoke anything at Google.** The customer's grant
  survives in their own account settings; we simply stop being able to store or
  use it. Anyone unwinding this properly should also tell affected customers to
  remove Eva's access at
  `https://myaccount.google.com/permissions`, because leaving a live grant to an
  app that no longer uses it is exactly the kind of thing ruling 25 is careful
  about.

- **No data is transformed in either direction**, so this is reversible without
  loss provided no Google mailbox exists. That is the whole point of keeping the
  provider as one string on an existing row rather than a parallel table.
