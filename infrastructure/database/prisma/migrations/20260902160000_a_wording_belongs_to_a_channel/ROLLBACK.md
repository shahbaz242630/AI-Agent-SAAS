# ROLLBACK — 20260902160000_a_wording_belongs_to_a_channel

Migration 0039 adds a `channel` column to `lead_reply_templates` and
`lead_reply_decisions`, and widens both of the templates table's partial unique
indexes to include it. No row is deleted and no column is dropped.

| Change    | Detail                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------ |
| Added     | `lead_reply_templates.channel` — `NOT NULL`, every existing row set to `email`                   |
| Added     | `lead_reply_decisions.channel` — **nullable**, every existing row set to `email`                 |
| Added     | four CHECKs: channel values on both tables, subject-is-email-only, and null-channel-sent-nothing |
| Replaced  | `lead_reply_templates_single_automatic_key` — now `(organisation_id, channel)`                   |
| Replaced  | `lead_reply_templates_live_name_key` — now `(organisation_id, channel, lower(name))`             |
| Unchanged | every existing row's other columns, RLS policy and grants                                        |

## Before rolling back

🚨 **A ROLLBACK CAN FAIL, AND IT FAILS FOR A GOOD REASON.** The old automatic
index is unique per organisation. If any organisation has an automatic reply on
more than one channel, restoring it is refused:

```sql
-- Any organisation that would break the old index. Expect zero rows.
SELECT organisation_id, count(*)
  FROM lead_reply_templates
 WHERE is_automatic AND deleted_at IS NULL
 GROUP BY organisation_id
HAVING count(*) > 1;
```

Every row it returns is a customer with a second channel switched on. **Decide
which channel keeps its automatic reply and demote the others** before rolling
back — and understand what that means: the demoted channel stops answering
enquiries on its own, silently, because "no automatic reply" is a legitimate
state the product supports.

The same check for the name index:

```sql
-- Names that would collide once channel leaves the key. Expect zero rows.
SELECT organisation_id, lower(name), count(*)
  FROM lead_reply_templates
 WHERE deleted_at IS NULL
 GROUP BY organisation_id, lower(name)
HAVING count(*) > 1;
```

## How to tell if this migration is the cause

A refused write names the constraint:

```
new row for relation "lead_reply_templates" violates check constraint
"lead_reply_templates_channel_check"
```

That means something wrote a channel other than `email`. Until the WhatsApp
slice ships, that is a bug in the caller, not a constraint that is too tight —
the CHECK is deliberately narrow so an unhandled channel cannot be stored.

```
new row for relation "lead_reply_decisions" violates check constraint
"lead_reply_decisions_subject_is_email_only_check"
```

That means a non-email reply carried a subject line. WhatsApp has no such
concept, so the caller is wrong.

If an error does not name one of those constraints, this migration is not why.

## Rollback SQL

```sql
BEGIN;

-- Run the two SELECTs above FIRST. This will fail otherwise, which is correct.
DROP INDEX "lead_reply_templates_single_automatic_key";
CREATE UNIQUE INDEX "lead_reply_templates_single_automatic_key"
  ON "lead_reply_templates"("organisation_id")
  WHERE "is_automatic" AND "deleted_at" IS NULL;

DROP INDEX "lead_reply_templates_live_name_key";
CREATE UNIQUE INDEX "lead_reply_templates_live_name_key"
  ON "lead_reply_templates"("organisation_id", lower("name"))
  WHERE "deleted_at" IS NULL;

ALTER TABLE "lead_reply_decisions"
  DROP CONSTRAINT IF EXISTS "lead_reply_decisions_null_channel_sent_nothing_check";
ALTER TABLE "lead_reply_decisions"
  DROP CONSTRAINT IF EXISTS "lead_reply_decisions_subject_is_email_only_check";
ALTER TABLE "lead_reply_decisions"
  DROP CONSTRAINT IF EXISTS "lead_reply_decisions_channel_check";
ALTER TABLE "lead_reply_decisions" DROP COLUMN IF EXISTS "channel";

ALTER TABLE "lead_reply_templates"
  DROP CONSTRAINT IF EXISTS "lead_reply_templates_channel_check";
ALTER TABLE "lead_reply_templates" DROP COLUMN IF EXISTS "channel";

COMMIT;
```

⚠️ **DROPPING THE COLUMN LOSES WHICH CHANNEL EACH WORDING WAS FOR**, and there is
no way to recover it — a WhatsApp wording and an email wording become
indistinguishable rows. If more than one channel is live, export the table first:

```sql
COPY (SELECT id, organisation_id, channel, name, is_automatic
        FROM lead_reply_templates WHERE deleted_at IS NULL)
  TO STDOUT WITH CSV HEADER;
```

## What the application does after a rollback

Code from slice 3.2b onward reads and writes `channel` on both tables, so a
rollback without a matching code rollback fails immediately and loudly — an
unknown column is an error, not a silent wrong answer. That is the better
failure: unlike migration 0038, this one cannot half-work.

The seeding is the one thing worth knowing. `ensureDefaultTemplates` seeds once
per organisation **per channel**, and it decides "once" by whether any row
exists for that organisation and channel. After a rollback the column is gone,
the query reverts to per-organisation, and an organisation that already has
email wordings still counts as seeded — so nothing is duplicated.

## Why the decision's channel is nullable and the template's is not

A template always has a channel: somebody wrote it for one. A **decision** may
not. `leads.source` still legally holds the three retired call-shaped values —
migration 0027 kept them legal because `lead_evidence` is immutable and one real
production lead is a `callback_request` — and there is no channel Eva can answer
those on.

So NULL means _"no channel could be determined, and nothing was sent"_. The
alternative was writing `email` on a row where email was never the answer, which
falsifies the only record we keep of what a stranger did or did not receive.
`lead_reply_decisions_null_channel_sent_nothing_check` is what stops such a row
ever claiming otherwise.

## Why the channel is a column and not a second table

`lead_reply_templates_whatsapp` would duplicate every column, every index, every
RLS policy and every grant, and would make "show me this customer's wordings" a
union that grows with each channel. The rows are the same shape; only the medium
differs. A column is the honest model, and the partial unique indexes are what
make it behave correctly per channel rather than merely record one.
