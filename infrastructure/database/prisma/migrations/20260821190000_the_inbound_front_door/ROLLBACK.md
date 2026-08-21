# ROLLBACK — 20260821190000_the_inbound_front_door

Migration 0029 opens the front door: an address each customer publishes, and a
record of everything delivered to it. Additive only — nothing existing is
renamed, narrowed or dropped.

| Change    | Detail                                                                    |
| --------- | ------------------------------------------------------------------------- |
| Added     | `inbound_addresses` — one live address per organisation, never reissued    |
| Added     | `inbound_messages` — every delivery, written before anything is decided    |
| Added     | RLS `tenant_isolation` on both, migration 0008's shape                     |
| Added     | RLS `inbound_address_routing` — SELECT-only, keyed to a dedicated GUC      |
| Granted   | `SELECT, INSERT, UPDATE` on both to `eva_app`; `DELETE` explicitly revoked |
| Unchanged | `leads`, `lead_evidence`, `consent_texts` — 0027 already allows email      |

## Before rolling back

```sql
-- Addresses that are, or have been, printed on a customer's website.
SELECT count(*) FROM inbound_addresses;

-- Enquiries that exist ONLY because they arrived by email. Dropping the tables
-- does not delete these leads, but it does delete how they got here.
SELECT count(*) FROM inbound_messages WHERE status = 'converted';

-- Anything unfinished: a fetch that never completed, or a conversion that threw.
SELECT id, status, failure_reason FROM inbound_messages
WHERE status IN ('received', 'failed');
```

**⚠️ IF THE FIRST QUERY RETURNS ANYTHING BUT `0`, THOSE ADDRESSES ARE PUBLIC AND
YOU CANNOT UN-PUBLISH THEM.** They are on websites, in lead-form settings, and
in the address books of everyone who has ever enquired. Dropping the table does
not stop mail being sent to them — it stops us being able to route it, so every
enquiry that arrives after the rollback is refused with nowhere to go and no
record that it was tried. **Export `inbound_addresses` in full before dropping
it**, because the addresses are the only way to restore service without asking
every customer to change their website.

**⚠️ ROLLING BACK LOSES THE LOOP-STOPPER EVIDENCE.** `inbound_messages.headers`
holds the `Auto-Submitted` / `Precedence` / `List-*` headers that ruling 32's
reply rules depend on. Headers cannot be recovered after the fact — the
forwarded copy is the only copy — so a rollback that later gets rolled forward
leaves a gap no code can fill.

**If the third query returns rows, they are unfinished work.** Resend will stop
retrying them; nobody will ever get those leads. Export them before dropping.

## Rollback SQL

```sql
-- Order matters: inbound_messages holds the FK.
DROP TABLE IF EXISTS "inbound_messages";
DROP TABLE IF EXISTS "inbound_addresses";
```

Policies, indexes and grants go with the tables; nothing else needs unwinding.

## Notes

- **⚠️ THE APPLICATION MUST GO BACK TOO, AND IT WILL NOT FAIL LOUDLY.** Unlike
  0028, the post-0029 code does not crash against the pre-0029 shape in any
  obvious place: `GET /organisations/:id/inbound-address` throws at Prisma, but
  the inbound webhook answers **401 or 500 to Resend**, which reads to Resend as
  a transient fault and is retried for a while and then dropped. Enquiries would
  be lost quietly. **Take the webhook out of the Resend dashboard BEFORE
  rolling back**, so mail bounces at the provider instead of vanishing at us.

- **Leads already created are untouched.** `leads` and `lead_evidence` are
  platform tables from 0026 and hold their own copy of everything that matters —
  sender, recipient, subject, excerpt and the provider's message id.
  `inbound_messages.lead_id` is `ON DELETE SET NULL`, so this drops the trail
  from delivery to lead, not the lead. What is lost is the full message body and
  the headers.

- **`DELETE` was revoked on both tables, and the drop still works.** `DROP TABLE`
  is an ownership operation, not a row privilege — `eva` owns these, `eva_app`
  merely uses them. The revoke stops a tidy-up script erasing the record of how
  a lead came to exist; it was never meant to stop a migration.

- **The unique index on `address` covers soft-deleted rows deliberately**, so an
  address we have ever issued can never be handed to a second organisation. If
  this migration is ever re-applied from an export, **preserve the revoked rows**
  — dropping them would make those addresses available again, and mail meant for
  the business that gave one up would be delivered into a stranger's lead book.

- **`inbound_address_routing` is a deliberate hole in tenant isolation** and the
  only one in the system. It is SELECT-only, matches a single row by exact
  address, and returns nothing when `app.current_inbound_address` is unset. If
  it is ever re-created by hand, re-create it exactly: a policy of `USING (true)`
  would expose every customer's address to any query on the table.
