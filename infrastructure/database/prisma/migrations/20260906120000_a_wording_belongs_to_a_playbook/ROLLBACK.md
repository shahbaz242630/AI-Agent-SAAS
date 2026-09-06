# ROLLBACK — 20260906120000_a_wording_belongs_to_a_playbook

Migration 0045 creates `lead_playbooks` (the switch per behaviour), adds
`lead_reply_templates.playbook_key` (which card a wording belongs to), backfills
both from the old `is_automatic` flag and the seed's "Out of hours" name, and
then **drops `is_automatic`** and its partial unique index.

| Change  | Detail                                                                                               |
| ------- | ---------------------------------------------------------------------------------------------------- |
| Added   | table `lead_playbooks` — `key` CHECK of five, `enabled`, one live row per organisation per key       |
| Added   | `lead_reply_templates.playbook_key` (nullable, same CHECK), `lead_reply_templates_live_playbook_key` |
| Data    | live automatic wordings → `instant_reply`; live "Out of hours" wordings → `after_hours`              |
| Data    | one `lead_playbooks` row per organisation per bound key (instant reply on, out of hours off)         |
| Removed | `lead_reply_templates.is_automatic` and `lead_reply_templates_single_automatic_key`                  |

## Before rolling back

Nothing is lost by the rollback itself: `is_automatic` is re-derived from
`playbook_key = 'instant_reply'`, which is exactly what the backfill set it
from. What IS lost is any wording bound to a card since the migration — the
rollback SQL keeps the rows and only forgets which card they belonged to — and
every switch a customer pressed, because the table that held them goes.

Check whether anything beyond the backfill has happened, so the loss is known:

```sql
-- Wordings bound to a card other than the two the backfill knows.
SELECT count(*) FROM "lead_reply_templates"
WHERE "playbook_key" NOT IN ('instant_reply', 'after_hours') AND "deleted_at" IS NULL;

-- Switches somebody pressed (the backfill writes created_by NULL).
SELECT count(*) FROM "lead_playbooks" WHERE "created_by" IS NOT NULL;
```

A non-zero second count is a customer's decision; write it down before it goes.

## Rollback SQL

```sql
ALTER TABLE "lead_reply_templates" ADD COLUMN "is_automatic" BOOLEAN NOT NULL DEFAULT false;

UPDATE "lead_reply_templates"
SET "is_automatic" = true
WHERE "playbook_key" = 'instant_reply' AND "deleted_at" IS NULL;

-- The 0039 shape: one automatic reply per organisation per channel, live rows.
CREATE UNIQUE INDEX "lead_reply_templates_single_automatic_key"
  ON "lead_reply_templates"("organisation_id", "channel")
  WHERE "is_automatic" AND "deleted_at" IS NULL;

DROP INDEX "lead_reply_templates_live_playbook_key";
ALTER TABLE "lead_reply_templates" DROP CONSTRAINT "lead_reply_templates_playbook_key_check";
ALTER TABLE "lead_reply_templates" DROP COLUMN "playbook_key";

DROP TABLE "lead_playbooks";

DELETE FROM "_prisma_migrations"
WHERE migration_name = '20260906120000_a_wording_belongs_to_a_playbook';
```

Then redeploy the api at a commit before this migration's PR: the api on `main`
after it reads `playbook_key` and `lead_playbooks` on every enquiry reply and on
the Automations screen, and neither exists once this has run.
