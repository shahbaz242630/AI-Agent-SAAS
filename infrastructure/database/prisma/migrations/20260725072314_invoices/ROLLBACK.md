# ROLLBACK — 20260725072314_invoices

This migration creates the Slice 1.2 `invoices` table with its CHECK
constraints (positive amount; the nine stored statuses), the partial unique
index on `(organisation_id, invoice_number) WHERE deleted_at IS NULL`, the
RLS tenant-isolation policy, and explicit `eva_app` grants.

## Rollback SQL

```sql
DROP TABLE IF EXISTS invoices;
```

Dropping the table also drops its RLS policy, indexes, CHECK constraints and
foreign keys — no separate `DROP POLICY` / `DROP INDEX` steps are needed. The
`GRANT` dies with the table.

## Notes

- **Data loss:** rollback destroys all invoice data. Export first if the table
  holds real rows; invoices are financially significant records and must never
  be casually dropped in staging/production.
- Re-applying after rollback re-runs the full migration including the CHECK
  constraints, partial unique index, RLS policy and grants — no manual steps.
- Forward-only convention (BRD 18): prefer a new corrective migration over
  rolling back once real data exists.
