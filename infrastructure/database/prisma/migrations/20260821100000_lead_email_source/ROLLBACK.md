# ROLLBACK — 20260821100000_lead_email_source

Migration 0027 widens two CHECK constraints so that `email_enquiry` is a legal
lead source and evidence channel. No tables, columns, indexes, policies or
grants change. Nothing is dropped and no data is touched.

| Constraint                    | Before                                                 | After             |
| ----------------------------- | ------------------------------------------------------ | ----------------- |
| `leads_source_check`          | `missed_call`, `existing_customer`, `callback_request` | + `email_enquiry` |
| `lead_evidence_channel_check` | `missed_call`, `existing_customer`, `callback_request` | + `email_enquiry` |

## Rollback SQL

```sql
-- ⚠️ RUN THE DATA CHECK BELOW FIRST. This narrows the allowed values, so it
-- FAILS — loudly, which is the desired behaviour — if any row already uses
-- 'email_enquiry'.
ALTER TABLE "leads" DROP CONSTRAINT "leads_source_check";
ALTER TABLE "leads"
  ADD CONSTRAINT "leads_source_check"
    CHECK ("source" IN ('missed_call', 'existing_customer', 'callback_request'));

ALTER TABLE "lead_evidence" DROP CONSTRAINT "lead_evidence_channel_check";
ALTER TABLE "lead_evidence"
  ADD CONSTRAINT "lead_evidence_channel_check"
    CHECK ("channel" IN ('missed_call', 'existing_customer', 'callback_request'));
```

## Before rolling back

```sql
SELECT count(*) FROM leads WHERE source = 'email_enquiry';
SELECT count(*) FROM lead_evidence WHERE channel = 'email_enquiry';
```

Both must be `0`. If either is not, **do not roll back** — those are real
enquiries with real evidence behind them, and a narrowing `ALTER` cannot run
while they exist. Deleting them to make the rollback succeed destroys the proof
that the business was allowed to contact those people (BRD 4.3, PECR). Export
first and decide deliberately.

## Notes

- **The forward migration is additive and cannot fail on existing data.** It
  only ever widens, so it is safe to re-apply and safe to run against a
  database holding any mixture of the four values.

- **⚠️ THE THREE CALL SOURCES ARE RETIRED, NOT REMOVED, AND THAT IS THE POINT.**
  `missed_call`, `existing_customer` and `callback_request` stay legal in the
  database because lead `cc1c3243` on production is a `callback_request` and
  `lead_evidence` holds no `UPDATE` grant for the app role — evidence of how
  somebody got in touch is exactly what must not be rewritten. The gate that
  actually stopped them is in the application: `LEAD_SOURCES` in
  `@eva/validation` is `['email_enquiry']`, so the API refuses the other three
  with a 400. **A future migration must not "tidy up" by narrowing this CHECK**
  unless it has first dealt with that row honestly.

- **Lead Follow-up by Call will want those three values back.** When that
  product is built it owns `missed_call`, `existing_customer` and
  `callback_request`, and they are already legal here — that product needs to
  add them to its own source list in the application layer, not to the
  database.

- **`website_form` is deliberately absent.** Founder ruling 2026-08-21: the
  customer's website form emails them, so a web lead IS an email lead. A value
  nothing produces is a value that only ever appears in a dropdown — the same
  mistake `endsAt` made in migration 0024.
