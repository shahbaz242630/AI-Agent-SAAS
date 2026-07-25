# ROLLBACK — 20260725100330_imports

This migration creates the Slice 1.3 `imports` and `import_rows` tables with
their CHECK constraints (`imports.file_type` csv/xlsx; the four stored import
statuses; the six staged-row statuses), the RLS tenant-isolation policies, and
explicit `eva_app` grants.

## Rollback SQL

```sql
DROP TABLE IF EXISTS import_rows;
DROP TABLE IF EXISTS imports;
```

`import_rows` must be dropped first (it holds foreign keys to `imports` and
`invoices`). Dropping the tables also drops their RLS policies, indexes, CHECK
constraints and foreign keys — no separate `DROP POLICY` / `DROP INDEX` steps
are needed. The `GRANT`s die with the tables. The `invoices` table itself is
untouched; only the FK reference from `import_rows.created_invoice_id` goes
away with the dropped table.

## Notes

- **Data loss:** rollback destroys all staged import data (uploads, staged
  rows, preview/report evidence). Invoices CREATED by a completed import are
  not removed — they are ordinary draft invoices and remain; only the
  `created_invoice_id` back-references disappear with the dropped tables.
- Re-applying after rollback re-runs the full migration including the CHECK
  constraints, RLS policies and grants — no manual steps.
- Forward-only convention (BRD 18): prefer a new corrective migration over
  rolling back once real data exists.
