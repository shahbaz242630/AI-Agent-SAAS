# ROLLBACK — 20260726070021_reminders

This migration creates the Slice 1.5 reminder-sequence tables (Phase 1.5 plan
§3): `reminder_sequences` (one default per org among live rows, partial unique
index), `reminder_steps` (the six BRD 4.1 stage keys + action-type CHECKs,
partial unique on `(sequence_id, key)` among live rows), `scheduled_actions`
(the durable send queue: full seven-state lifecycle CHECK,
`UNIQUE (invoice_id, reminder_step_id, scheduled_date)` — BRD 4.1 duplicate
prevention) and `human_escalations` (one escalation per fired step via the
unique `scheduled_action_id` FK), each with its RLS tenant-isolation policy
and explicit `eva_app` grants.

## Rollback SQL

```sql
DROP TABLE IF EXISTS human_escalations;
DROP TABLE IF EXISTS scheduled_actions;
DROP TABLE IF EXISTS reminder_steps;
DROP TABLE IF EXISTS reminder_sequences;
```

Dropping each table also drops its RLS policy, indexes, CHECK constraints and
foreign keys — no separate `DROP POLICY` / `DROP INDEX` steps are needed. The
grants die with the tables. Drop order matters only for readability: the FKs
between the four tables mean `human_escalations` and `scheduled_actions` must
go before the tables they reference (or use `DROP TABLE ... CASCADE`).

## Notes

- **Data loss:** rollback destroys all reminder sequences and their step
  configuration, the entire scheduled-action send queue (pending/ready
  reminders not yet sent), and all open/resolved human escalations. Invoices
  and customers are untouched — only the FK references from the dropped tables
  go away. After rollback, the organisation has no reminder schedule; 1.7
  sending must not run against a database rolled back past this migration.
- Re-applying after rollback re-runs the full migration including the CHECK
  constraints, partial unique indexes, RLS policies and grants — no manual
  steps. Sequences are NOT recreated automatically: the default sequence is
  provisioned lazily by the API the next time scheduling touches the org
  (Phase 1.5 plan §3 — no backfill migration).
- Forward-only convention (BRD 18): prefer a new corrective migration over
  rolling back once real data exists.
