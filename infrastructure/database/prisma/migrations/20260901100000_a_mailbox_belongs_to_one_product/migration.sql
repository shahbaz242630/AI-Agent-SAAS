-- Slice 3.1c-0 — migration 0034: a mailbox belongs to ONE product.
--
-- Ruling 36, finally built, and hardened by the founder on 2026-09-01:
-- "they should have full complete seperate setups.. nothing combined/shared ..
--  if later one is switched off the other one is not impacted and keeps working".
--
-- ⚠️ WHAT THIS FIXES IS A LIVE DEFECT, NOT ONLY A GAP. Until this migration a
-- mailbox belonged to the ORGANISATION, so `resolveCapabilities` counted every
-- mailbox for every product: connect Outlook for Invoice Chasing and Lead
-- Follow-up immediately reported itself set up, with a mailbox it was never
-- given. The screen said ready, the seat was billed to a product the customer
-- may not even own, and the first reply would have gone out of the wrong
-- account. Nobody could have chosen otherwise, because there was nothing on the
-- row to choose with.
--
-- ⚠️ THE SAME ADDRESS ON TWO PRODUCTS IS ALLOWED, AND THAT IS THE POINT OF THE
-- SECOND INDEX BELOW. Our customer is a one-person trade with ONE address.
-- Blocking `mike@mikesplumbing.co.uk` from being connected to both products
-- would stop exactly the customer we sell to from buying both. It costs two
-- seats and it is two separate OAuth grants — separate rows, separate tokens,
-- separate health — which is what makes the products genuinely independent
-- rather than merely labelled. Founder ruling 2026-08-22, re-confirmed
-- 2026-09-01 after considering a block and rejecting it.
--
-- ⚠️ EVA CANNOT READ ANY OF THESE MAILBOXES, WHICH IS WHY SHARING AN ADDRESS IS
-- SAFE. Gmail is granted `gmail.send` only; Microsoft calls `/me/sendMail` and
-- an inbox-exists probe and nothing else. Enquiries arrive at an address WE own
-- (migration 0029), never out of the customer's inbox, so there is no shared
-- pile of mail for the two products to confuse. The worry that one address
-- would make Eva mix up leads and invoice replies describes a mechanism that
-- does not exist.

-- ---------------------------------------------------------------------------
-- 1. The column.
-- ---------------------------------------------------------------------------
--
-- Added WITH a default so the back-fill is the same statement, then the default
-- is DROPPED immediately below. Both halves matter and they pull opposite ways:
--
--   * With a permanent default, any future code path that forgets to name the
--     product silently files the mailbox under Invoice Chasing. That is the
--     failure this project keeps meeting — a wrong value that nothing reports —
--     and it would put a customer's Lead Follow-up mailbox on another product's
--     seat with every screen still showing green.
--   * With no default at all, the back-fill needs its own UPDATE and the column
--     cannot be NOT NULL in one pass.
--
-- So: default for the length of this migration, gone by the end of it. After
-- this runs, an INSERT that does not name a product FAILS, loudly, which is the
-- only behaviour that cannot hide.

ALTER TABLE "email_accounts"
  ADD COLUMN "module_key" TEXT NOT NULL DEFAULT 'email_credit_controller';

-- ⚠️ THE BACK-FILL IS THE DEFAULT ABOVE, AND IT IS CORRECT RATHER THAN MERELY
-- CONVENIENT. Every mailbox that exists today was connected through a flow that
-- only Invoice Chasing had — Lead Follow-up has never been able to send at all,
-- so no live row can belong to it. On production this is ONE row.

ALTER TABLE "email_accounts" ALTER COLUMN "module_key" DROP DEFAULT;

-- ---------------------------------------------------------------------------
-- 2. The CHECK, and the spec that keeps it honest.
-- ---------------------------------------------------------------------------
--
-- ⚠️ A CHECK, DELIBERATELY, RATHER THAN A FOREIGN KEY TO `organisation_modules`.
-- The founder's rule is that switching a product off must leave the other
-- working — and, just as much, that switching a product off does not destroy
-- its own mailbox. An FK ties the mailbox's right to exist to a row that
-- entitlement code owns and edits; this column is answering a different
-- question ("which product is this FOR"), and it must keep answering it while
-- the product is off, unpaid, or not yet bought.
--
-- ⚠️ THIS LIST AND `MODULE_KEYS` IN packages/types ARE ONE FACT WRITTEN TWICE.
-- `mailbox-module-keys.spec.ts` fails the build if they disagree — the same
-- guard `email_accounts_provider_check` has had since migration 0030, and for
-- the same reason: widen one without the other and either nobody can connect a
-- mailbox for the new product, or every mailbox on it becomes unusable. Neither
-- failure announces itself.

ALTER TABLE "email_accounts"
  ADD CONSTRAINT "email_accounts_module_key_check"
    CHECK ("module_key" IN (
      'email_credit_controller',
      'voice_credit_controller',
      'lead_follow_up_email',
      'lead_follow_up_voice',
      'ai_receptionist'
    ));

-- ---------------------------------------------------------------------------
-- 3. One address per PRODUCT, not per organisation.
-- ---------------------------------------------------------------------------
--
-- The old index (migration 0017) read (organisation_id, lower(email_address))
-- and was written when a mailbox belonged to the organisation. Left alone it
-- would enforce the block the founder rejected: connect Gmail to Invoice
-- Chasing and the same address could never be connected to Lead Follow-up.
--
-- Case-insensitivity is preserved and is not decoration: Microsoft is
-- case-insensitive, so reconnecting `Sara@acme.com` must reuse the row created
-- for `sara@acme.com` rather than quietly consume a second seat.

DROP INDEX "email_accounts_live_address_key";

CREATE UNIQUE INDEX "email_accounts_live_address_key"
  ON "email_accounts"("organisation_id", "module_key", lower("email_address"))
  WHERE "deleted_at" IS NULL;

-- ---------------------------------------------------------------------------
-- 4. One default sending mailbox per PRODUCT, not per organisation.
-- ---------------------------------------------------------------------------
--
-- The old index (migration 0017) allowed exactly one `is_primary` row per
-- organisation — one address everything sent from. Two independent products
-- each need their own, and without this change the second product could never
-- have a default at all: the first product's primary would occupy the only slot
-- and the insert would fail with a unique violation nobody could act on.

DROP INDEX "email_accounts_single_primary_key";

CREATE UNIQUE INDEX "email_accounts_single_primary_key"
  ON "email_accounts"("organisation_id", "module_key")
  WHERE "is_primary" AND "deleted_at" IS NULL;

-- ---------------------------------------------------------------------------
-- 5. The lookup every send now makes.
-- ---------------------------------------------------------------------------
--
-- Every seat count, readiness check and send resolution is now "this
-- organisation's mailboxes FOR THIS PRODUCT". The existing index is on
-- organisation_id alone, which was the whole question before today and is now
-- half of it.

CREATE INDEX "email_accounts_organisation_module_idx"
  ON "email_accounts"("organisation_id", "module_key")
  WHERE "deleted_at" IS NULL;

-- ---------------------------------------------------------------------------
-- What deliberately does NOT change.
-- ---------------------------------------------------------------------------
--
-- * RLS policies and grants on `email_accounts` — the tenant boundary is
--   organisation_id and this migration does not touch it. A product column is
--   not a security boundary and must never be mistaken for one: both products
--   belong to the same tenant, and it is the API's job to scope by product.
-- * `customers.email_account_id` — the per-client "chase from this address"
--   choice. Founder ruling 2026-09-01: that filing stays an INVOICE CHASING
--   feature. Clients are shared across products (ruling 15), so a shared client
--   filed under one product's mailbox would leave the other product with no
--   answer; instead Lead Follow-up ignores the filing entirely and replies from
--   its own product default. No column moves, and Invoice Chasing's behaviour
--   is bit-for-bit what it was.
-- * `is_primary` itself, `provider`, the token columns, health, and the seat
--   accounting shape. A mailbox is stored exactly as it was — it simply now
--   says which product it is for.
