-- Migration 0020: which mailbox chases which client (Slice 1.6b, Task 1).
--
-- Slice 1.6a made an organisation able to HOLD several mailboxes. It did not
-- make them useful: exactly one — the primary — sends, and the rest sit
-- connected and idle. A seat bought a spare, not capacity. This column is what
-- turns a seat into "an active sending mailbox that owns a set of clients".
--
-- Scope and rulings: docs/ALLOCATION-SCOPE.md
-- Plan (Task 1, decision D2): docs/Slice 1.6b/SLICE-1.6B-IMPLEMENTATION-PLAN.md

-- --- customers --------------------------------------------------------------

-- NULLABLE, and that is ruling 1 rather than laziness. NULL means "chase this
-- client from the organisation's DEFAULT mailbox", never "do not chase". A NOT
-- NULL column would mean the day an organisation adds a second seat, every
-- existing client goes quiet until somebody files them one by one — and nothing
-- in the product would say so. A forgotten allocation sending from the wrong
-- address is visible and correctable; sending nothing is invisible, and it is
-- the customer's lost revenue.
ALTER TABLE "customers" ADD COLUMN "email_account_id" UUID;

-- --- the same-organisation guarantee ----------------------------------------

-- Redundant against the primary key by design: it is the target a composite
-- foreign key requires. Cheap (one index) and load-bearing.
ALTER TABLE "email_accounts"
  ADD CONSTRAINT "email_accounts_organisation_id_id_key" UNIQUE ("organisation_id", "id");

-- THE CONSTRAINT THAT MATTERS.
--
-- A plain REFERENCES email_accounts(id) would let organisation A file a client
-- under organisation B's mailbox. RLS does not catch it: the tenant_isolation
-- policy on `customers` checks the CUSTOMER's organisation_id and never looks at
-- the mailbox at all. So without this, nothing but application code stands
-- between us and one company's chasing letters going out from another company's
-- address — the worst failure this product could have, and one that would be
-- discovered by the wrong person.
--
-- Composite, so the database refuses it outright. Postgres treats a foreign key
-- as satisfied when any of its columns is NULL, so ruling 1's "unallocated"
-- state is unaffected.
--
-- ON DELETE RESTRICT, not SET NULL and never CASCADE. The application never
-- hard-deletes a mailbox (disconnect soft-deletes the row and nulls the tokens),
-- so this only fires on manual database surgery — and there it must fail loudly
-- rather than silently re-file a whole book of clients onto the default address.
-- Scope §4a requires only "not cascade"; this is the stricter of the two options
-- that satisfy it.
ALTER TABLE "customers"
  ADD CONSTRAINT "customers_email_account_same_org_fkey"
  FOREIGN KEY ("organisation_id", "email_account_id")
  REFERENCES "email_accounts" ("organisation_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Serves the per-mailbox client count on the settings card, the bulk clear on
-- disconnect, and 1.7's send-time resolution. Partial on both counts: most rows
-- are unallocated by design (ruling 1), and a soft-deleted client is never
-- chased — the 0011/0013/0017/0019 precedent.
CREATE INDEX "customers_email_account_id_idx"
  ON "customers"("email_account_id")
  WHERE "email_account_id" IS NOT NULL AND "deleted_at" IS NULL;

-- --- deliberately absent: a backfill ----------------------------------------
--
-- The exact opposite of migration 0017, where a MISSING backfill was the
-- rollout risk. Here a backfill IS the risk (ALLOCATION-SCOPE trap 1).
--
-- Stamping today's primary mailbox onto every existing client would work
-- perfectly on the day it shipped, and start misbehaving months later: the
-- moment somebody changes their default mailbox, every stamped client carries on
-- being chased from the old address. No error, no log line, no failing test.
--
-- So every existing row stays NULL and the answer is computed at SEND time,
-- every time. That is Task 6's `resolveSendingMailbox`, and it is the only place
-- the question is ever answered.

-- No GRANTs needed: `customers` and `email_accounts` both already exist with RLS
-- enabled + forced, their tenant_isolation policies and their eva_app grants. A
-- new column and a new constraint inherit all of it. (Contrast a NEW table,
-- which since 0014-0016 is created with no privileges at all.)
