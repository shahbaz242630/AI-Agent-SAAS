# ROLLBACK — 20260822120000_we_confirm_the_forwarding_ourselves

Migration 0031 adds one table and two columns, so that a Gmail customer can
forward their enquiries to Eva without ever seeing Google's confirmation code —
and so that a confirmation nobody asked for is answered by the customer rather
than by us.

| Change    | Detail                                                                                     |
| --------- | ------------------------------------------------------------------------------------------ |
| Added     | table `inbound_forwarding_requests` (+ 3 indexes, RLS policy, grants)                      |
| Added     | `inbound_addresses.forwarding_armed_at`, `inbound_addresses.forwarding_armed_by`           |
| Unchanged | every existing column, index, policy and grant on `inbound_addresses` / `inbound_messages` |

Additive only. Nothing existing is altered or rewritten, so applying it cannot
lose data and no backfill runs.

## Before rolling back

```sql
-- Forwarding requests that would be destroyed. Each one is a record of somebody
-- asking to have mail delivered into this organisation's lead book.
SELECT status, count(*) FROM inbound_forwarding_requests GROUP BY status;

-- The ones that matter most: confirmations a human refused. This is the only
-- evidence anywhere that somebody tried to read a customer's enquiries.
SELECT id, organisation_id, source_address, created_at, settled_at
FROM inbound_forwarding_requests
WHERE status = 'declined';

-- Customers whose forwarding is live. Rolling back does not switch their
-- forwarding off — see the notes.
SELECT organisation_id, source_address, settled_at
FROM inbound_forwarding_requests
WHERE status = 'confirmed';
```

**⚠️ IF THE SECOND QUERY RETURNS ANYTHING, EXPORT IT BEFORE DROPPING THE TABLE.**
A declined request is a security event — the record of an address being guessed
or mistyped into somebody else's Gmail. The table holds `REVOKE DELETE` for
exactly that reason, and `DROP TABLE` walks straight past a revoke.

## Rollback SQL

```sql
DROP TABLE "inbound_forwarding_requests";

ALTER TABLE "inbound_addresses"
  DROP COLUMN "forwarding_armed_at",
  DROP COLUMN "forwarding_armed_by";
```

`DROP TABLE` removes the RLS policy, the three indexes and the grants with it;
they do not need dropping separately.

## Notes

- **⚠️ ROLLING BACK DOES NOT STOP ANY MAIL, AND THAT IS THE DANGEROUS PART.**
  A confirmed forwarding rule lives in the CUSTOMER'S Gmail settings, not here.
  Dropping this table forgets that we ever agreed to it; Gmail carries on
  forwarding regardless, and those enquiries keep arriving and keep becoming
  leads. What is lost is only our record of who asked and whether anyone said
  yes. Anyone unwinding this for real must also ask affected customers to turn
  forwarding off in Gmail — nothing on our side can do it for them.

- **⚠️ THE APPLICATION MUST GO BACK TOO.** With the table gone, the intake path
  still recognises a Gmail confirmation email and still declines to make a lead
  from it — but has nowhere to write it down, so it throws, the webhook answers
  5xx and Resend retries it forever. There is no graceful degradation here by
  design: silently dropping a confirmation email would leave a customer watching
  a screen that never moves.

- **The armed window is not a permission and losing it grants nothing.**
  `forwarding_armed_at` only ever widens what Eva will confirm automatically,
  and only for a few minutes. Dropping the columns fails closed: every request
  becomes one a human has to answer, which is the safe direction.

- **`inbound_messages` rows survive.** A confirmation email that was already
  recorded stays recorded, with `status = 'ignored'` and its reason. That is
  deliberate: the message is the evidence, this table is only what we decided
  about it.
