-- Slice 3.1a follow-up — migration 0028: a do-not-contact recorded by mistake
-- can be corrected, without a genuine request ever becoming reversible.
--
-- ⚠️ THE PROBLEM, IN THE FOUNDER'S WORDS: "honour a request permanently" and
-- "any button press is irreversible" are different promises, and we were making
-- the second. `suppression_list` had no delete path in the application AND no
-- UPDATE or DELETE grant for `eva_app` (migration 0005), so an entry created by
-- a mis-click was permanent for everybody, us included. On 2026-08-20 the
-- founder came within one click of permanently silencing a real client's
-- billing address, and the only thing that stopped it was a warning added the
-- same day.
--
-- ⚠️ THE FIX IS APPEND-ONLY AND THE GRANTS DO NOT MOVE. A correction is a NEW
-- ROW saying "this was recorded in error", never an edit and never a delete.
-- The compliance guarantee is unchanged: nothing in this database can rewrite
-- or remove the record of what happened. What changes is how the CURRENT state
-- is read.
--
-- ⚠️ A ROW IS NO LONGER "THIS VALUE IS SUPPRESSED". Up to now the question was
-- `EXISTS(SELECT 1 FROM suppression_list WHERE ...)`. From here it is "what does
-- the NEWEST row for this value say" — and any query still asking the old
-- question will treat a corrected entry as live. That is why the table is
-- RENAMED: `suppression_list` returning rows that are corrections is a name
-- that lies, and a hand-written `SELECT * FROM suppression_list` would read
-- every one of them as a do-not-contact.
--
-- ⚠️ THE UNIQUE KEY HAD TO GO, AND THIS IS THE PART WORTH READING TWICE.
-- (organisation_id, channel, value) was UNIQUE, which is what made re-adding a
-- suppression idempotent. It cannot survive corrections: somebody suppressed by
-- mistake, corrected, and then GENUINELY asking not to be contacted six months
-- later needs a second `suppress` row. With the unique key in place that insert
-- fails — or worse, the old upsert's `update: {}` makes it a silent no-op and
-- the stale correction still wins, so a real person's real request does
-- nothing. A compliance request that silently does nothing is the worst defect
-- this table could carry, so the constraint goes and idempotency moves into
-- `addSuppression`, which does not write when the value is already suppressed.
--
-- The rename is lossless: ALTER TABLE ... RENAME keeps every row, index,
-- constraint, RLS policy and grant. Production holds ZERO suppression rows
-- today (checked before writing this), so there is nothing to move even if it
-- were not.

-- ---------------------------------------------------------------------------
-- The table, and what its rows now mean
-- ---------------------------------------------------------------------------

ALTER TABLE "suppression_list" RENAME TO "suppression_events";

ALTER TABLE "suppression_events" RENAME CONSTRAINT "suppression_list_pkey"
  TO "suppression_events_pkey";
ALTER TABLE "suppression_events" RENAME CONSTRAINT "suppression_list_organisation_id_fkey"
  TO "suppression_events_organisation_id_fkey";

-- ⚠️ DEFAULT 'suppress' IS WHAT MAKES THIS SAFE ON EXISTING DATA. Every row
-- that already exists was a do-not-contact request, so they all read correctly
-- as `suppress` events with no back-fill and no guesswork.
ALTER TABLE "suppression_events"
  ADD COLUMN "action" TEXT NOT NULL DEFAULT 'suppress';

ALTER TABLE "suppression_events"
  ADD CONSTRAINT "suppression_events_action_check"
    CHECK ("action" IN ('suppress', 'correct')),
  -- ⚠️ A CORRECTION MUST SAY WHY, AT THE DATABASE LAYER. Undoing somebody's
  -- do-not-contact is the one action here that needs to be answerable for
  -- later, and "the form requires it" is a promise a script does not keep.
  ADD CONSTRAINT "suppression_events_correction_reason_check"
    CHECK ("action" <> 'correct' OR "reason" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- The unique key goes; the lookup index replaces it
-- ---------------------------------------------------------------------------

DROP INDEX "suppression_list_organisation_id_channel_value_key";

-- Newest-first per value, which is the only question the send paths ask.
CREATE INDEX "suppression_events_organisation_id_channel_value_created_at_idx"
  ON "suppression_events"("organisation_id", "channel", "value", "created_at");

-- ---------------------------------------------------------------------------
-- Permanence, re-asserted
-- ---------------------------------------------------------------------------
--
-- ⚠️ THE RENAME ALREADY CARRIES THE 0005 REVOKE ACROSS — privileges follow the
-- table, not its name. This repeats it anyway because a GRANT only ever adds:
-- if any later migration or restore hands `eva_app` a blanket grant, the
-- append-only guarantee disappears with nothing failing. Saying it again here
-- costs nothing and is checked by `rls.spec.ts`.

REVOKE UPDATE, DELETE ON "suppression_events" FROM eva_app;
