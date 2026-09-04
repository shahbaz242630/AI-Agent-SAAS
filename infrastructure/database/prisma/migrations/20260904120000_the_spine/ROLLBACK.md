# ROLLBACK — 20260904120000_the_spine

Migration 0041 creates six tables and a view, adds three nullable columns to
`leads`, widens two CHECK constraints, and backfills the new tables from rows
that already exist. Nothing that existed before it is removed or rewritten
except those three columns and the two CHECKs.

| Change     | Detail                                                                                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Added      | `people`, `person_identities`, `pipeline_stages`, `conversations`, `messages`, `activities`                                                                                                        |
| Added      | `person_timeline` — a `security_invoker` view over `messages` ∪ `activities`                                                                                                                       |
| Added      | `leads.person_id`, `leads.pipeline_stage_id`, `leads.origin_conversation_id` (all nullable)                                                                                                        |
| Widened    | `leads_source_check` and `lead_evidence_channel_check` admit `whatsapp_enquiry`                                                                                                                    |
| Added      | RLS (forced) with `tenant_isolation` on all six tables                                                                                                                                             |
| Added      | grants: `SELECT, INSERT, UPDATE` on four; `SELECT, INSERT` only on `messages` and `activities`; DELETE revoked everywhere                                                                          |
| Backfilled | system stages per organisation; people + identities from clients, contacts, leads and WhatsApp senders; threads and messages from the raw inbound tables and sent replies; the three lead pointers |

## Before rolling back

⚠️ **NOTHING IN THESE TABLES IS THE ONLY COPY OF ANYTHING — YET.** Every
backfilled row points back at its source (`messages.source_table/source_id`,
`leads.contact_*`, the raw inbound tables). That stops being true the moment
3.3b ships: a human note on a timeline (3.3c) or a stage change has no other
home. Check before dropping:

```sql
-- Expect zero: anything here was written by a person, not the backfill.
SELECT count(*) FROM activities;
-- Expect zero rows newer than the migration: 3.3b's normaliser wrote them.
SELECT count(*) FROM messages
WHERE created_at > (SELECT finished_at FROM _prisma_migrations WHERE migration_name = '20260904120000_the_spine');
```

## Rolling back

```sql
DROP VIEW IF EXISTS "person_timeline";
ALTER TABLE "leads"
  DROP COLUMN IF EXISTS "origin_conversation_id",
  DROP COLUMN IF EXISTS "pipeline_stage_id",
  DROP COLUMN IF EXISTS "person_id";
DROP TABLE IF EXISTS "activities";
DROP TABLE IF EXISTS "messages";
DROP TABLE IF EXISTS "conversations";
DROP TABLE IF EXISTS "pipeline_stages";
DROP TABLE IF EXISTS "person_identities";
DROP TABLE IF EXISTS "people";

-- The CHECKs go back to 0027's value set. Refused if a whatsapp_enquiry lead
-- exists — export or soft-delete it first; evidence rows cannot be rewritten
-- (0026), so a WhatsApp lead's evidence must be deleted with its lead.
ALTER TABLE "leads" DROP CONSTRAINT "leads_source_check";
ALTER TABLE "leads" ADD CONSTRAINT "leads_source_check"
  CHECK ("source" IN ('email_enquiry', 'missed_call', 'existing_customer', 'callback_request'));
ALTER TABLE "lead_evidence" DROP CONSTRAINT "lead_evidence_channel_check";
ALTER TABLE "lead_evidence" ADD CONSTRAINT "lead_evidence_channel_check"
  CHECK ("channel" IN ('email_enquiry', 'missed_call', 'existing_customer', 'callback_request'));

DELETE FROM "_prisma_migrations" WHERE migration_name = '20260904120000_the_spine';
```

Policies, indexes and grants go with the tables. Order matters: `leads` holds
foreign keys into `people`, `pipeline_stages` and `conversations`, so its
columns drop first.
