# ROLLBACK — 20260904130000_a_do_not_contact_is_a_consent_event

Migration 0042 renames the do-not-contact log to `consent_events`, renames its
`action` column to `state` (rewriting `suppress` → `opted_out` and `correct` →
`corrected`, one to one), adds the six consent columns with their CHECKs, and
leaves `suppression_events` behind as a `security_invoker`, SELECT-only view in
the old shape. No row is added or removed.

| Change    | Detail                                                                                                                                                      |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renamed   | `suppression_events` → `consent_events` (plus its pkey, FK and lookup index)                                                                                |
| Renamed   | column `action` → `state`; values `suppress` → `opted_out`, `correct` → `corrected`; default `opted_out`                                                    |
| Replaced  | CHECKs: `state IN ('opted_in','opted_out','corrected')`; a `corrected` row must carry a `reason`                                                            |
| Added     | `purpose TEXT NOT NULL DEFAULT 'all'`, `basis TEXT`, `source TEXT NOT NULL DEFAULT 'user'`, `evidence JSONB`, `jurisdiction TEXT`, `expires_at TIMESTAMPTZ` |
| Added     | CHECKs on `purpose`, `basis`, `source`, `jurisdiction`; consent names a purpose; exactly the opt-ins carry a basis; only a consent expires                  |
| Added     | view `suppression_events` (`security_invoker`), `SELECT` only for `eva_app`, showing `purpose = 'all'` rows in the old columns                              |
| Unchanged | RLS policy; `eva_app` still has no `UPDATE` or `DELETE` on the table                                                                                        |

## Before rolling back

```sql
-- Expect zero: rows the old shape cannot hold. Anything here was written by
-- code that does not exist yet (the engine's consent writer) or by hand.
SELECT count(*) FROM consent_events
WHERE purpose <> 'all' OR state = 'opted_in'
   OR basis IS NOT NULL OR evidence IS NOT NULL
   OR jurisdiction IS NOT NULL OR expires_at IS NOT NULL
   OR source <> 'user';
```

**⚠️ If that returns anything but `0`, the rollback DROPS those facts.** A
marketing opt-in or a STOP with its evidence has nowhere to go in the old
table. Export them first (`SELECT * FROM consent_events WHERE ...` with the same
predicate) and decide, row by row, whether each becomes a `suppress` under the
old rules or is kept aside.

The four rows that existed when 0042 ran (2 `suppress`, 2 `correct`, one
organisation) round-trip exactly.

## Rollback SQL

```sql
DROP VIEW IF EXISTS "suppression_events";

ALTER TABLE "consent_events"
  DROP CONSTRAINT "consent_events_expiry_on_consent_only_check",
  DROP CONSTRAINT "consent_events_jurisdiction_check",
  DROP CONSTRAINT "consent_events_source_check",
  DROP CONSTRAINT "consent_events_basis_on_consent_only_check",
  DROP CONSTRAINT "consent_events_basis_check",
  DROP CONSTRAINT "consent_events_consent_names_a_purpose_check",
  DROP CONSTRAINT "consent_events_purpose_check",
  DROP CONSTRAINT "consent_events_correction_reason_check",
  DROP CONSTRAINT "consent_events_state_check";

ALTER TABLE "consent_events"
  DROP COLUMN "expires_at",
  DROP COLUMN "jurisdiction",
  DROP COLUMN "evidence",
  DROP COLUMN "source",
  DROP COLUMN "basis",
  DROP COLUMN "purpose";

-- Refused if any row is `opted_in` — that is the check above, enforced.
UPDATE "consent_events"
SET "state" = CASE "state"
  WHEN 'opted_out' THEN 'suppress'
  WHEN 'corrected' THEN 'correct'
END;
ALTER TABLE "consent_events" ALTER COLUMN "state" SET NOT NULL;
ALTER TABLE "consent_events" ALTER COLUMN "state" SET DEFAULT 'suppress';
ALTER TABLE "consent_events" RENAME COLUMN "state" TO "action";

ALTER TABLE "consent_events"
  ADD CONSTRAINT "suppression_events_action_check"
    CHECK ("action" IN ('suppress', 'correct')),
  ADD CONSTRAINT "suppression_events_correction_reason_check"
    CHECK ("action" <> 'correct' OR "reason" IS NOT NULL);

ALTER INDEX "consent_events_organisation_id_channel_value_created_at_idx"
  RENAME TO "suppression_events_organisation_id_channel_value_created_at_idx";
ALTER TABLE "consent_events" RENAME CONSTRAINT "consent_events_organisation_id_fkey"
  TO "suppression_events_organisation_id_fkey";
ALTER TABLE "consent_events" RENAME CONSTRAINT "consent_events_pkey"
  TO "suppression_events_pkey";
ALTER TABLE "consent_events" RENAME TO "suppression_events";

DELETE FROM "_prisma_migrations"
WHERE migration_name = '20260904130000_a_do_not_contact_is_a_consent_event';
```

The RLS policy, the remaining index and the grants follow the table through
every rename; `eva_app` keeps `SELECT, INSERT` and nothing else, as before.
Then redeploy the api at a commit before this migration's PR — the code on
`main` after it reads `consent_events`, and the view under the old name is
gone.
