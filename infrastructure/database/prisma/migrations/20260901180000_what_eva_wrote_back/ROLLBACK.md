# ROLLBACK — 20260901180000_what_eva_wrote_back

Migration 0036 adds `lead_reply_decisions` — one row per lead recording what
Eva decided about it and, if she answered, exactly what was sent. It creates
one table and changes nothing that existed before it.

| Change    | Detail                                                                         |
| --------- | ------------------------------------------------------------------------------ |
| Added     | table `lead_reply_decisions`                                                   |
| Added     | `lead_reply_decisions_organisation_id_idx`                                     |
| Added     | `lead_reply_decisions_one_per_lead_key` (partial unique — the idempotency key) |
| Added     | `lead_reply_decisions_waiting_idx` (partial — the review queue's query)        |
| Added     | four CHECK constraints (verdict, status, and two consistency rules)            |
| Added     | RLS: `ENABLE` + `FORCE`, policy `tenant_isolation` on `app.current_org`        |
| Added     | `GRANT SELECT, INSERT, UPDATE` then `REVOKE DELETE` for `eva_app`              |
| Unchanged | `leads`, `lead_reply_templates`, every other table, policy and grant           |

Purely additive, so this is a `DROP TABLE`.

## ⚠️ Before rolling back — read this one properly

```sql
-- What would be destroyed, and it is not all the same kind of thing.
SELECT verdict, status, count(*) AS rows, min(created_at) AS earliest
FROM lead_reply_decisions
WHERE deleted_at IS NULL
GROUP BY verdict, status
ORDER BY verdict, status;
```

🚨 **EVERY `status = 'sent'` ROW IS THE ONLY RECORD THAT A REAL MESSAGE WAS SENT
TO A REAL PERSON, IN A CUSTOMER'S NAME.** It carries the recipient, the exact
words, and the timestamp. That is not operational data — it is the answer to
"what did you send my customer, and when?", and under PECR/GDPR it is the kind
of thing a business may be asked to produce.

**Copy it out before dropping the table:**

```sql
CREATE TABLE lead_reply_decisions_backup_0036 AS
  SELECT * FROM lead_reply_decisions;
```

That backup sits outside RLS and outside the application. Treat it as customer
data: it contains strangers' email addresses and the messages they received.
Drop it once the table is restored, or it becomes an unguarded copy of exactly
the thing this table exists to protect.

⚠️ **AND `leads.first_responded_at` IS NOT ROLLED BACK BY THIS FILE.** The reply
path stamps it, and it lives on a platform table that migration 0036 never
touched. After a rollback those stamps remain, pointing at replies whose record
no longer exists — leads that look answered with nothing to show for it. That
is recoverable (the value is still true; a reply really was sent) but it must
not be mistaken for corruption:

```sql
-- How many leads would be left claiming a reply the schema can no longer explain.
SELECT count(*) FROM leads WHERE first_responded_at IS NOT NULL AND deleted_at IS NULL;
```

## Rollback SQL

```sql
BEGIN;

-- Indexes, policy, grants and constraints all go with the table.
DROP TABLE "lead_reply_decisions";

COMMIT;
```

## What the application does after a rollback

Every read and write disappears with the code rolled back alongside it. If the
table is dropped while the NEW api is still running, **every inbound enquiry
still becomes a lead** — intake is a separate path and does not touch this table
— but the reply attempt throws, and the enquiry screen 500s wherever it shows
the decision.

**Roll the code back first, then the schema**, the reverse of the deploy order.

⚠️ **THE FAILURE MODE IS THE SAFE ONE, AND THAT IS BY DESIGN.** The reply is
attempted after the lead is committed and never inside intake's transaction, so
a broken reply path loses replies, not enquiries. Nothing a stranger sent is
dropped because Eva could not answer it.
