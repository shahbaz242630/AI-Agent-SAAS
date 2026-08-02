# ROLLBACK — 20260802160000_customer_mailbox_allocation

Migration 0020 adds `customers.email_account_id` — which mailbox chases which
client (slice 1.6b, `docs/ALLOCATION-SCOPE.md`).

Additive only. One nullable column, one redundant UNIQUE, one composite foreign
key and one partial index. No table is created, no column is dropped, no
constraint is tightened on existing data, and **there is no backfill** — so the
migration cannot fail on existing rows.

| Table            | Added                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `customers`      | `email_account_id`, `customers_email_account_same_org_fkey`, `customers_email_account_id_idx` |
| `email_accounts` | `email_accounts_organisation_id_id_key` (UNIQUE — the composite foreign key's target)         |

## Rollback SQL

```sql
DROP INDEX IF EXISTS "customers_email_account_id_idx";

ALTER TABLE "customers"
  DROP CONSTRAINT IF EXISTS "customers_email_account_same_org_fkey",
  DROP COLUMN IF EXISTS "email_account_id";

-- Only after the foreign key above is gone: it is this constraint's dependent.
ALTER TABLE "email_accounts"
  DROP CONSTRAINT IF EXISTS "email_accounts_organisation_id_id_key";
```

Order matters. Dropping the UNIQUE first fails while the composite foreign key
still references it.

## Notes

- **Structurally reversible, NOT reversible in meaning.** Dropping the column
  destroys every client-to-mailbox filing an organisation has done. It cannot be
  reconstructed: the audit trail (`customer.reassigned`) records the moves, but
  replaying it is a manual exercise, not a script that exists.
- **Rolling back is SAFE for sending, unlike 0019.** Every client falls back to
  the organisation's default mailbox (ruling 1), so chasing continues from a real
  address belonging to the same business. Nobody stops being chased. What is lost
  is _which_ address — a multi-seat customer's clients would all be chased from
  the default until they are re-filed. Visible and correctable, which is exactly
  the trade ruling 1 makes.
- **Do not roll back while slice 1.7 is sending** without telling the affected
  customers first. Their clients will silently change the address they are
  chased from, mid-conversation, which is the thing `ALLOCATION-SCOPE` trap 1
  exists to prevent.
- **The composite foreign key is a security control, not a tidiness one.**
  Dropping it re-opens cross-tenant allocation: with only application code
  guarding it, a defect in the allocation endpoint could file organisation A's
  client under organisation B's mailbox, and Eva would then chase A's debtor
  from B's address. If this must be dropped, the allocation endpoints have to be
  disabled in the same change.
- **`ON DELETE RESTRICT` blocks a hard `DELETE` of an allocated mailbox**, which
  is intended. If a genuine hard delete is ever needed, clear the allocations
  first (`UPDATE customers SET email_account_id = NULL WHERE email_account_id = $1`)
  inside the same transaction — that is what the disconnect path does, and it
  keeps ruling 1's fallback intact.
- **A hard `DELETE` of an organisation is untested against this constraint.**
  Organisations are soft-deleted everywhere in the application, so the cascade
  path is not exercised; if a future operation needs it, delete clients before
  mailboxes.
- **No privilege changes.** Both tables already carry RLS enabled + forced,
  `tenant_isolation`, and their `eva_app` grants; a new column and constraint
  inherit them. Nothing to re-grant on rollback.
