-- Slice 1.5 — migration 0011: BRD 4.1 duplicate prevention covers LIVE rows
-- only (founder ruling 2026-07-26).
--
-- Migration 0009's absolute unique index on (invoice_id, reminder_step_id,
-- scheduled_date) also pinned CANCELLED rows, so a recompute (cancel + fresh
-- schedule — plan §7.5) could never re-insert an unchanged (step, date) slot.
-- `cancelled` is terminal: cancelled rows are never revived. The constraint
-- therefore becomes a PARTIAL unique index over live rows only — a cancelled
-- slot is free for a fresh insert, while two live rows for the same slot are
-- still refused (the retry-idempotency mechanism is unchanged).

DROP INDEX "scheduled_actions_invoice_step_date_key";

CREATE UNIQUE INDEX "scheduled_actions_live_invoice_step_date_key"
  ON "scheduled_actions"("invoice_id", "reminder_step_id", "scheduled_date")
  WHERE "status" <> 'cancelled';
