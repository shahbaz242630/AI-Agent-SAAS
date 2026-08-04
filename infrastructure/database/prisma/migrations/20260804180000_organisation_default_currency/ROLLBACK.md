# ROLLBACK — 20260804180000_organisation_default_currency

Migration 0022 adds `organisation_settings.default_currency` (Slice 1.6c, task 13) — the currency a new invoice's dropdown opens on.

Additive only: one column with a `NOT NULL DEFAULT 'GBP'` and one CHECK
constraint. No table is created or dropped, no existing column is altered, and
no data is rewritten — every existing row is backfilled to `GBP` by the default
in the same statement.

| Table                   | Changed                                            |
| ----------------------- | -------------------------------------------------- |
| `organisation_settings` | **+ `default_currency`** `TEXT NOT NULL` = `GBP`   |
| `organisation_settings` | **+ `organisation_settings_default_currency_chk`** |

## Rollback SQL

```sql
ALTER TABLE "organisation_settings"
  DROP CONSTRAINT IF EXISTS "organisation_settings_default_currency_chk";

ALTER TABLE "organisation_settings"
  DROP COLUMN IF EXISTS "default_currency";
```

## Notes

- **⚠️ ROLLING BACK LOSES EVERY ORGANISATION'S CHOICE, SILENTLY AND
  PERMANENTLY.** Dropping the column discards the setting itself, not a
  derivable value — a Dubai business that set `AED` is back to being offered
  `GBP` on every invoice, with nothing to say so. Capture them first if the
  rollback might be reversed:

  ```sql
  SELECT organisation_id, default_currency
  FROM organisation_settings
  WHERE default_currency <> 'GBP';
  ```

- **Nothing is stored in terms of this column, so no invoice is affected.** It
  decides which option a form pre-selects and is never read to refuse or to
  reinterpret a currency. Every invoice carries its own `currency`, and that is
  what the money layer uses. A rollback therefore cannot change what any
  existing invoice is worth.

- **The application code must move with the column.** `OrganisationSummary`
  publishes `defaultCurrency`, and `PATCH /organisations/:id/settings` writes
  it. Dropping the column without reverting the code leaves Prisma selecting a
  column that is not there — Prisma selects all scalar fields by default, so
  the failure is immediate and total, not subtle. Revert the code in the same
  change, not afterwards.

- **The web falls back on its own if the field is absent** (`lib/currencies.ts`
  → `GBP`), so a web build that outlives the column degrades to the pre-task-13
  behaviour rather than breaking. That is a safety net for a partial deploy, not
  a licence to leave them out of step.

- **No privilege changes.** `organisation_settings` already carries RLS
  enabled+forced, `tenant_isolation`, and its `eva_app` grants. Adding a column
  does not disturb them; nothing to re-grant in either direction.
