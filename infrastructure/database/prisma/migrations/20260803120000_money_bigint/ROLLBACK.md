# ROLLBACK — 20260803120000_money_bigint

Migration 0021 widens `invoices.amount_minor_units` and
`invoices.amount_paid_minor_units` from `INTEGER` to `BIGINT` (Slice 1.6c), so
that an invoice denominated in a low-unit-value currency fits.

Type widening only. No table is created, no column added or dropped, no
constraint changed. `INTEGER` → `BIGINT` is a widening conversion, so every
existing row converts without loss and the migration cannot fail on existing
data.

| Table      | Changed                                                        |
| ---------- | -------------------------------------------------------------- |
| `invoices` | `amount_minor_units`, `amount_paid_minor_units` → **`BIGINT`** |

## Rollback SQL

```sql
ALTER TABLE "invoices"
  ALTER COLUMN "amount_minor_units" TYPE INTEGER,
  ALTER COLUMN "amount_paid_minor_units" TYPE INTEGER;
```

## Notes

- **⚠️ NARROWING FAILS LOUDLY ON DATA THAT NO LONGER FITS, AND THAT IS THE POINT.**
  `BIGINT` → `INTEGER` raises `integer out of range` for any row above
  2,147,483,647 and aborts the whole statement. Nothing is silently truncated —
  but the rollback simply will not complete while such a row exists, and the only
  ways forward are to correct those invoices by hand or to stay on `BIGINT`.
  Check before attempting it:

  ```sql
  SELECT id, invoice_number, currency, amount_minor_units, amount_paid_minor_units
  FROM invoices
  WHERE amount_minor_units > 2147483647
     OR amount_paid_minor_units > 2147483647;
  ```

- **What the old ceiling meant depends entirely on the currency.** 2,147,483,647
  minor units is ~21.4 million GBP/AED/USD (2 digits), ~2.1 million KWD/BHD/OMR
  (3 digits), and ~2.1 billion JPY/VND (0 digits). Under the pre-1.6c code, which
  multiplied every amount by 100 regardless of currency, a Vietnamese invoice
  overflowed at roughly **$860**. Rolling back re-imposes all of that.

- **Both CHECK constraints survive untouched** — `amount_minor_units > 0` and
  `amount_paid_minor_units >= 0`. Widening preserves constraints, and `BIGINT`
  satisfies both comparisons natively; nothing needs re-creating in either
  direction.

- **The application code must move with the column.** Prisma maps `BIGINT` to the
  TypeScript `bigint`, which `JSON.stringify` refuses to serialise. The API
  converts at the response boundary via `minorUnitsToNumber`
  (`packages/types/src/money.ts`), which throws rather than lose precision beyond
  `Number.MAX_SAFE_INTEGER`. Rolling the column back to `INTEGER` without also
  reverting `schema.prisma` leaves Prisma expecting a `bigint` from an `INTEGER`
  column — so revert the code in the same change, not afterwards.

- **No privilege changes.** `invoices` already carries RLS enabled+forced,
  `tenant_isolation`, and its `eva_app` grants. Altering a column's type does not
  disturb them; nothing to re-grant in either direction.

- **Deploy ordering still applies** (handoff §0b): back up → migrate cloud →
  verify → merge → verify again. Prisma selects all scalar columns by default, so
  a generated client expecting `bigint` will read the new type on its first query.
