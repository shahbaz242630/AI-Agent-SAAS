# ROLLBACK — 20260821140000_suppression_becomes_a_log

Migration 0028 turns the do-not-contact record from a list of suppressed values
into an append-only log of events, so an entry recorded by mistake can be
superseded without anything ever being edited or deleted.

| Change    | Detail                                                                       |
| --------- | ---------------------------------------------------------------------------- |
| Renamed   | `suppression_list` → `suppression_events` (plus its pkey and FK)             |
| Added     | `action TEXT NOT NULL DEFAULT 'suppress'`, CHECK `IN ('suppress','correct')` |
| Added     | CHECK: a `correct` row must carry a `reason`                                 |
| Dropped   | `UNIQUE (organisation_id, channel, value)`                                   |
| Added     | index on `(organisation_id, channel, value, created_at)`                     |
| Unchanged | RLS policy, and `eva_app` still has no `UPDATE` or `DELETE`                  |

## Before rolling back

```sql
-- Corrections cannot survive a rollback: the old shape has nowhere to put them.
SELECT count(*) FROM suppression_events WHERE action = 'correct';

-- The unique key cannot be restored while any value has more than one row.
SELECT organisation_id, channel, value, count(*)
FROM suppression_events
GROUP BY 1, 2, 3
HAVING count(*) > 1;
```

**⚠️ If the first query returns anything but `0`, rolling back SILENTLY
RE-SUPPRESSES those people.** A correction row is the only record that an entry
was made in error; drop it and the entry underneath it reads as a live
do-not-contact again. That is the safe direction to fail in — nobody gets
contacted who should not be — but it is still wrong, and the person who
corrected it will not be told. Export the corrections first and re-apply them
by hand afterwards.

**If the second query returns rows, the rollback will FAIL** on the unique
index. That is correct behaviour, not a fault: two rows for one value means a
suppress → correct → suppress history that the old shape cannot express.

## Rollback SQL

```sql
DROP INDEX "suppression_events_organisation_id_channel_value_created_at_idx";

ALTER TABLE "suppression_events"
  DROP CONSTRAINT "suppression_events_correction_reason_check",
  DROP CONSTRAINT "suppression_events_action_check",
  DROP COLUMN "action";

ALTER TABLE "suppression_events" RENAME CONSTRAINT "suppression_events_organisation_id_fkey"
  TO "suppression_list_organisation_id_fkey";
ALTER TABLE "suppression_events" RENAME CONSTRAINT "suppression_events_pkey"
  TO "suppression_list_pkey";

ALTER TABLE "suppression_events" RENAME TO "suppression_list";

CREATE UNIQUE INDEX "suppression_list_organisation_id_channel_value_key"
  ON "suppression_list"("organisation_id", "channel", "value");

-- Privileges follow the table through a rename, but re-assert anyway: a GRANT
-- only ever adds, and this one is the compliance guarantee.
REVOKE UPDATE, DELETE ON "suppression_list" FROM eva_app;
```

## Notes

- **⚠️ THE APPLICATION MUST GO BACK TOO.** After a rollback `isSuppressed` has
  to be the old `EXISTS` question again. Running the post-0028 code against the
  pre-0028 shape fails at Prisma — the model has no `action` column to read —
  so this fails loudly rather than quietly, which is the intended direction.

- **DROPPING THE UNIQUE KEY WAS NOT TIDINESS.** A value that is suppressed,
  corrected, and then genuinely asked for again needs a second `suppress` row.
  Under the old unique key that insert fails, and under the old `upsert` with
  `update: {}` it was a silent no-op that left the stale correction winning —
  a real person's real request doing nothing. Any future migration that wants
  the constraint back has to answer that case first.

- **Idempotency moved from the database to `addSuppression`.** It reads the
  current state and does not write when the value is already suppressed, so
  asking twice still leaves one row. The database no longer enforces that, and
  two identical `suppress` rows would be harmless anyway — the newest still
  says `suppress`. What the database DOES still enforce is the part that
  matters: nothing can be updated or deleted, ever.

- **`action` defaults to `'suppress'` deliberately.** Every row that existed
  before this migration was a do-not-contact request, so the default is the
  truth for all of them and there is no back-fill to get wrong. Production held
  zero rows when this was written.
