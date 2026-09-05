# ROLLBACK — 20260905120000_eva_can_answer_on_whatsapp

Migration 0044 widens two CHECK constraints so `lead_reply_templates.channel`
and `lead_reply_decisions.channel` admit `whatsapp`. It adds no column and
changes no row.

| Change  | Detail                                                                                     |
| ------- | ------------------------------------------------------------------------------------------ |
| Changed | `lead_reply_templates_channel_check`: `('email')` → `('email','whatsapp')`                 |
| Change  | `lead_reply_decisions_channel_check`: `NULL OR ('email')` → `NULL OR ('email','whatsapp')` |

## Before rolling back

The old CHECKs refuse any WhatsApp row, so **both queries must return zero**
first. A non-zero count is a wording a customer wrote or a record of what a
stranger received; neither is deleted by a rollback — retire the wordings
through the product (soft delete) and leave the decisions, which are evidence,
and do not roll back.

```sql
SELECT count(*) FROM "lead_reply_templates" WHERE "channel" <> 'email';
SELECT count(*) FROM "lead_reply_decisions" WHERE "channel" IS NOT NULL AND "channel" <> 'email';
```

## Rollback SQL

```sql
ALTER TABLE "lead_reply_templates" DROP CONSTRAINT "lead_reply_templates_channel_check";
ALTER TABLE "lead_reply_templates"
  ADD CONSTRAINT "lead_reply_templates_channel_check" CHECK ("channel" IN ('email'));

ALTER TABLE "lead_reply_decisions" DROP CONSTRAINT "lead_reply_decisions_channel_check";
ALTER TABLE "lead_reply_decisions"
  ADD CONSTRAINT "lead_reply_decisions_channel_check"
    CHECK ("channel" IS NULL OR "channel" IN ('email'));

DELETE FROM "_prisma_migrations"
WHERE migration_name = '20260905120000_eva_can_answer_on_whatsapp';
```

Then redeploy the api at a commit before this migration's PR: the api on `main`
after it seeds WhatsApp wordings on the first read of the Replies screen and
writes WhatsApp decisions, both of which the narrowed CHECKs refuse.
