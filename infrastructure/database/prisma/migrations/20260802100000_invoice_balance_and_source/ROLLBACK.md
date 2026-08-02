# ROLLBACK — 20260802100000_invoice_balance_and_source

Migration 0019 adds the fields Eva needs to chase an invoice accurately, after
reviewing a real accounting package against this schema
(`docs/DATA-MODEL-REVIEW.md`).

Additive only. No table is created, no column is dropped, no constraint is
tightened on existing data, and every new column is either nullable or has a
default — so the migration cannot fail on existing rows and requires no
backfill.

| Table                   | Added                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `invoices`              | `amount_paid_minor_units`, `last_payment_at`, `customer_reference`, `payment_terms`, `description`, `source`, `external_id` |
| `customers`             | `payment_terms`, `source`, `external_id`                                                                                    |
| `organisation_settings` | `payment_instructions`                                                                                                      |

## Rollback SQL

```sql
DROP INDEX IF EXISTS "customers_external_ref_key";
DROP INDEX IF EXISTS "invoices_external_ref_key";

ALTER TABLE "organisation_settings" DROP COLUMN IF EXISTS "payment_instructions";

ALTER TABLE "customers"
  DROP CONSTRAINT IF EXISTS "customers_source_check",
  DROP COLUMN IF EXISTS "external_id",
  DROP COLUMN IF EXISTS "source",
  DROP COLUMN IF EXISTS "payment_terms";

ALTER TABLE "invoices"
  DROP CONSTRAINT IF EXISTS "invoices_source_check",
  DROP CONSTRAINT IF EXISTS "invoices_amount_paid_check",
  DROP COLUMN IF EXISTS "external_id",
  DROP COLUMN IF EXISTS "source",
  DROP COLUMN IF EXISTS "description",
  DROP COLUMN IF EXISTS "payment_terms",
  DROP COLUMN IF EXISTS "customer_reference",
  DROP COLUMN IF EXISTS "last_payment_at",
  DROP COLUMN IF EXISTS "amount_paid_minor_units";
```

## Notes

- **Cleanly reversible structurally, NOT reversible in meaning.** Dropping
  `amount_paid_minor_units` destroys every record of how much has been paid. Any
  invoice sitting at status `partially_paid` immediately becomes indistinguishable
  from one nobody has paid a penny towards.
- **Rolling back re-introduces the defect this migration exists to fix.** Without
  a paid amount, the only figure available to the sender is the full invoice
  total, so a part-paid debtor gets chased for the whole sum. **Do not roll this
  back on any deployment where slice 1.7 is sending.** Fix forward instead
  (BRD 18, forward-only convention).
- **`external_id` loss breaks future re-syncs.** Once an accounting integration
  exists, dropping `external_id` orphans every mirrored row: the next sync cannot
  tell that a remote invoice is already present and will create duplicates.
  Rolling back after an integration has run therefore needs a deliberate
  de-duplication plan, not just this SQL.
- **Extending `source` needs a migration.** The CHECK deliberately enumerates the
  accepted systems so a typo (`Zoho` vs `zoho`) cannot silently break the
  uniqueness that prevents duplicate imports. Adding a provider means altering
  the constraint — accepted as the cheaper failure mode.
- **No privilege changes.** Every table altered here already carries RLS
  enabled+forced, `tenant_isolation`, and its `eva_app` grants; a new column
  inherits them. Nothing to re-grant on rollback.
