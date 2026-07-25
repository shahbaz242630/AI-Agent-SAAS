# ROLLBACK — 20260725151439_invoice_documents

This migration creates the Slice 1.4 `invoice_documents` table (uploaded
single-invoice PDFs + extraction outcome) with its status CHECK constraint
(`uploaded`/`extracted`/`confirmed`/`failed`), the RLS tenant-isolation
policy, and explicit `eva_app` grants.

## Rollback SQL

```sql
DROP TABLE IF EXISTS invoice_documents;
```

Dropping the table also drops its RLS policy, index, CHECK constraint and
foreign keys — no separate `DROP POLICY` / `DROP INDEX` steps are needed. The
`GRANT` dies with the table. The `invoices` table itself is untouched; only
the FK reference from `invoice_documents.invoice_id` goes away with the
dropped table.

## Notes

- **Data loss:** rollback destroys all staged invoice documents — the
  uploaded PDF bytes (`content`), extraction drafts (`extracted_fields`) and
  failure reasons. Invoices CREATED by a confirmed document are not removed —
  they are ordinary draft invoices and remain; only the `invoice_id`
  back-references disappear with the dropped table.
- Re-applying after rollback re-runs the full migration including the CHECK
  constraint, RLS policy and grants — no manual steps.
- Forward-only convention (BRD 18): prefer a new corrective migration over
  rolling back once real data exists.
