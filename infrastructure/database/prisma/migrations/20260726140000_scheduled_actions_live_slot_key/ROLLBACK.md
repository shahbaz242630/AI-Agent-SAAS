# ROLLBACK — 20260726140000_scheduled_actions_live_slot_key

This migration (0011; Slice 1.5, founder ruling 2026-07-26) replaces migration
0009's ABSOLUTE unique index on
`scheduled_actions (invoice_id, reminder_step_id, scheduled_date)` with a
PARTIAL unique index over live rows only (`WHERE status <> 'cancelled'`).
`cancelled` is terminal: a cancelled slot can be re-filled by a fresh insert
(recompute = cancel + insert-new; rows are never revived), while duplicate
LIVE rows for the same slot remain refused (BRD 4.1 duplicate prevention).

## Rollback SQL

```sql
DROP INDEX IF EXISTS scheduled_actions_live_invoice_step_date_key;
CREATE UNIQUE INDEX scheduled_actions_invoice_step_date_key
  ON scheduled_actions(invoice_id, reminder_step_id, scheduled_date);
```

## Notes

- **Rollback can fail:** if any (invoice, step, date) slot has BOTH a
  cancelled row and a live replacement (the state 0011 exists to permit), the
  absolute unique index cannot be recreated. Either delete one of the
  conflicting rows first or leave 0011 in place — check with:

  ```sql
  SELECT invoice_id, reminder_step_id, scheduled_date, COUNT(*)
  FROM scheduled_actions
  GROUP BY 1, 2, 3
  HAVING COUNT(*) > 1;
  ```

- **Data loss:** none by itself — the migration only swaps index definitions.
- Re-applying after rollback re-drops the absolute index and re-creates the
  partial one in a single step — no manual follow-up.
- Forward-only convention (BRD 18): prefer a new corrective migration over
  rolling back once real data exists.
